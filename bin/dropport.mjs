#!/usr/bin/env node
// dropport — reach your local dev servers at real hostnames over https, with no port.
//
//   dropport add remoteledger.local 5173
//   dropport up
//   -> https://remoteledger.local
//
// It is a thin, opinionated wrapper around Caddy: a registry of hostname -> port, a
// generated Caddyfile, the matching /etc/hosts lines, and a privileged service that
// can bind 80 and 443. Caddy issues the certificates from its own local CA, which is
// what makes https work without a browser warning.
import {
  CADDYFILE,
  HOME_DIR,
  REGISTRY,
  SUFFIX,
  bareLocalReason,
  expandHost,
  hostnameWarning,
  urlFor,
  validHostname,
  validPort,
} from "../src/config.mjs";
import { mdnsHosts, mdnsSupported } from "../src/mdns.mjs";
import {
  DATA_DIR,
  HOSTS_FILE,
  caddyPath,
  certTrusted,
  hostsNeedsUpdate,
  mdnsInstalled,
  installMdns,
  installService,
  portOptions,
  probe,
  probeHost,
  proxyRunning,
  resolveMs,
  readRegistry,
  reload,
  serviceInstalled,
  syncHosts,
  trustCa,
  uninstallMdns,
  uninstallService,
  validateConfig,
  writeCaddyfile,
  writeRegistry,
} from "../src/system.mjs";

const [, , cmd = "status", ...rest] = process.argv;
const say = (m = "") => console.log(m);
const die = (m) => {
  console.error(`  ${m}`);
  process.exit(1);
};

async function regenerate(apps) {
  const ports = await portOptions();
  writeRegistry(apps);
  writeCaddyfile(apps, { disableRedirects: ports.disableRedirects });
  const v = validateConfig();
  if (!v.ok) die(`generated a config Caddy rejects:\n${v.output}`);
  return ports;
}

async function add() {
  const force = rest.includes("--force");
  const [rawHost, port] = rest.filter((a) => a !== "--force");
  const host = expandHost(rawHost);

  // A bare .local name is a shared-namespace collision waiting to happen, so it is
  // refused by default rather than warned about and accepted anyway.
  const bare = bareLocalReason(host);
  if (bare && !force) {
    say(`  ${bare.why}`);
    say("");
    say("  Use a namespaced name instead:");
    say(`    dropport add ${bare.label} ${port || "<port>"}          ->  ${bare.suggestion}`);
    say("");
    say("  Or a .test name, reserved for local development and not multicast at all:");
    say(`    dropport add ${bare.label}.test ${port || "<port>"}`);
    say("");
    say(`  If you really mean ${bare.host}, pass --force.`);
    process.exit(1);
  }

  if (!validHostname(host)) die(`"${rawHost || ""}" is not a hostname. Try: dropport add myapp 3000`);
  if (!validPort(port)) die(`"${port || ""}" is not a port.`);

  if (host !== String(rawHost || "").toLowerCase()) say(`  ${rawHost} -> ${host}`);
  const warn = hostnameWarning(host);
  if (warn) say(`  note: ${warn}`);

  const apps = readRegistry().filter((a) => a.host !== host);
  apps.push({ host, port: Number(port) });
  const ports = await regenerate(apps);

  if (hostsNeedsUpdate(apps)) syncHosts(apps);
  if (ports.disableRedirects) say("  note: port 80 is taken by something else, so plain http:// will not reach this app. https does.");
  if (serviceInstalled()) {
    say(reload() ? "  proxy reloaded" : "  proxy did not reload — run: dropport up");
  } else {
    say("  registered. Run `dropport up` to start the proxy.");
  }
  say(`  ${urlFor({ host })}  ->  127.0.0.1:${port}`);
}

async function rm() {
  const [host] = rest;
  const before = readRegistry();
  const apps = before.filter((a) => a.host !== expandHost(host));
  if (apps.length === before.length) die(`${host} is not registered.`);
  await regenerate(apps);
  if (hostsNeedsUpdate(apps)) syncHosts(apps);
  if (serviceInstalled()) reload();
  say(`  removed ${host}`);
}

function list() {
  const apps = readRegistry();
  if (!apps.length) return say("  nothing registered yet — dropport add myapp.test 3000");
  for (const a of apps) say(`  ${urlFor(a).padEnd(38)} -> 127.0.0.1:${a.port}`);
}

async function up() {
  if (!caddyPath()) die("caddy is not installed. brew install caddy   (or see caddyserver.com/docs/install)");
  const apps = readRegistry();
  if (!apps.length) die("nothing registered yet — dropport add myapp.test 3000");
  const ports = await regenerate(apps);
  if (ports.https443) {
    die(
      "port 443 is already in use, so the proxy cannot serve https.\n" +
        "  Something else owns it — OrbStack, Docker Desktop or a local web server are the usual suspects.\n" +
        "  Stop it, or point that tool elsewhere, then run dropport up again."
    );
  }
  if (ports.disableRedirects) {
    say("  port 80 is taken, so redirects are off and Caddy binds 443 only.");
    say("  https://... works; plain http://... reaches whatever owns port 80.");
  }
  if (hostsNeedsUpdate(apps)) syncHosts(apps);
  installService();
  say("  proxy running.");

  // A hosts entry gets a .local name to the right address, but only after the resolver
  // waits ~5s for a multicast answer that never comes. Publishing it makes that instant.
  const local = mdnsHosts(apps);
  if (local.length && mdnsSupported()) {
    const ok = installMdns();
    say(ok
      ? `  publishing ${local.length} .local name(s) over mDNS, so they resolve instantly`
      : "  could not start the mDNS publisher — .local names will still work, just slowly");
  }
  await status();
}

async function down() {
  uninstallService();
  if (mdnsInstalled()) uninstallMdns();
  say("  proxy stopped. Hostnames stay in your hosts file; `dropport rm <host>` clears them.");
}

async function status() {
  const apps = readRegistry();
  const caddy = caddyPath();
  say(`  caddy   : ${caddy || "NOT INSTALLED — brew install caddy"}`);
  say(`  service : ${serviceInstalled() ? "installed" : "not installed — run: dropport up"}`);
  say(`  config  : ${CADDYFILE}`);
  say(`  data    : ${DATA_DIR}`);
  say(`  apps    : ${apps.length}`);
  if (!apps.length) return;

  for (const a of apps) {
    const front = await probeHost(a.host, { tls: a.tls !== false });
    const back = await probe(`http://127.0.0.1:${a.port}`);
    const verdict = front.ok
      ? `${front.status}`
      : back.ok
        ? `proxy not answering (${front.error})`
        : "your app is not running";
    say(`  ${urlFor(a).padEnd(38)} ${verdict}`);
  }
}

/** Explain, in order, why a hostname is not working yet. */
async function doctor() {
  const apps = readRegistry();
  let problems = 0;
  const bad = (m) => {
    problems++;
    say(`  ✗ ${m}`);
  };
  const good = (m) => say(`  ✓ ${m}`);

  caddyPath() ? good(`caddy at ${caddyPath()}`) : bad("caddy is not installed — brew install caddy");
  if (apps.length) good(`${apps.length} app(s) registered`);
  else bad("no apps registered — dropport add myapp.test 3000");

  const v = apps.length ? validateConfig() : { ok: true };
  v.ok ? good("Caddyfile is valid") : bad(`Caddyfile rejected:\n${v.output}`);

  const ports = await portOptions();
  if (ports.mine?.length) good(`this proxy holds port ${ports.mine.join(" and ")}`);
  if (ports.https443) bad("port 443 is held by something else — https cannot be served until that stops");
  else if (!ports.mine?.includes(443)) good("port 443 is free");
  if (ports.http80) say("  · port 80 is held by something else, so redirects are off. https still works.");

  hostsNeedsUpdate(apps) ? bad(`${HOSTS_FILE} is out of date — dropport up`) : good(`${HOSTS_FILE} is in sync`);

  // "installed" is not "running": a daemon that cannot bind is restarted forever by
  // launchd, and every attempt fails the same way with nothing on screen to say so.
  if (!serviceInstalled()) bad("service not installed — dropport up");
  else if (await proxyRunning()) good("service installed and running");
  else {
    bad("service is installed but the proxy is NOT running");
    say(`    it is most likely failing to bind a port and being restarted in a loop.`);
    say(`    check: tail "${DATA_DIR}/dropport.log"   then: dropport up`);
  }

  for (const a of apps) {
    const back = await probe(`http://127.0.0.1:${a.port}`);
    back.ok ? good(`${a.host}: your app is up on ${a.port}`) : bad(`${a.host}: nothing listening on ${a.port}`);

    // straight to the proxy over loopback, with the hostname as SNI — a slow or
    // failing .local lookup says nothing about whether the proxy is serving
    const front = await probeHost(a.host, { tls: a.tls !== false });
    if (front.ok) good(`${a.host}: the proxy serves it (HTTP ${front.status})`);
    else bad(`${a.host}: the proxy did not answer — ${front.error}`);

    const dnsr = await resolveMs(a.host);
    if (dnsr.error) bad(`${a.host}: the name does not resolve (${dnsr.error})`);
    else if (dnsr.ms > 1000) {
      bad(`${a.host}: resolves to ${dnsr.address}, but takes ${(dnsr.ms / 1000).toFixed(1)}s`);
      say(mdnsInstalled()
        ? "    the mDNS publisher is installed but nothing is answering — check ~/.dropport/mdns.log"
        : "    .local is answered by multicast DNS, and nothing replies, so the resolver waits out its timeout.");
      say("    fix: dropport up (publishes it over mDNS), or use a .test name, which skips mDNS entirely.");
    } else good(`${a.host}: resolves to ${dnsr.address} in ${dnsr.ms}ms`);
  }
  say("");
  say(problems ? `  ${problems} thing(s) to fix.` : "  all good.");
}

const HELP = `
dropport — local dev servers at real hostnames, over https, with no port

  dropport add <name> <port>   register an app (a bare name becomes <name>.${SUFFIX})
  dropport rm <host>           unregister it
  dropport list                what is registered
  dropport up                  install and start the proxy (needs sudo)
  dropport down                stop and remove it
  dropport trust               trust the local CA, so https has no warning (needs sudo)
  dropport mdns                publish .local names so they resolve instantly
  dropport status              is it working
  dropport doctor              why is it not working

Example
  dropport add remoteledger.local 5173
  dropport up
  open https://remoteledger.local

Sudo is needed for three things only: editing ${HOSTS_FILE}, installing a service
that may bind ports 80 and 443, and adding the local CA to your trust store. Each one
announces itself before it runs.

Registry: ${REGISTRY}
`;

try {
  switch (cmd) {
    case "add": await add(); break;
    case "rm":
    case "remove": await rm(); break;
    case "list":
    case "ls": list(); break;
    case "up":
    case "start": await up(); break;
    case "down":
    case "stop": await down(); break;
    case "mdns": {
      const local = mdnsHosts(readRegistry());
      if (!mdnsSupported()) { say("  mDNS publishing is not supported on this platform."); break; }
      if (!local.length) { say("  no .local hostnames registered — nothing needs publishing."); break; }
      say(installMdns() ? `  publishing: ${local.join(", ")}` : "  could not start the publisher");
      break;
    }
    case "trust": {
      const apps = readRegistry();
      const already = apps.length ? await certTrusted(urlFor(apps[0])) : false;
      if (already) { say("  already trusted — nothing to do."); break; }
      trustCa();
      say("  local CA trusted — https should be clean now.");
      break;
    }
    case "status": await status(); break;
    case "doctor": await doctor(); break;
    case "help":
    case "--help":
    case "-h": say(HELP); break;
    default:
      say(`  unknown command "${cmd}"`);
      say(HELP);
      process.exit(1);
  }
} catch (e) {
  die(String(e?.message || e));
}
