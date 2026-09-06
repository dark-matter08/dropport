// The half of dropport that touches the machine: locating Caddy, writing the config,
// editing /etc/hosts, and installing the privileged service that can bind 80 and 443.
//
// Everything that needs root is funnelled through sudo() so there is exactly one place
// that escalates, and it always says what it is about to do first.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { HOME_DIR, CADDYFILE, REGISTRY, applyHostsLines, buildCaddyfile, normalise, portDecision } from "./config.mjs";

export const MAC = platform() === "darwin";
// Overridable so the whole flow can be exercised against a scratch file in tests
// rather than requiring root and mutating the real one.
export const HOSTS_FILE =
  process.env.DROPPORT_HOSTS_FILE ||
  (platform() === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts");
export const LABEL = "dev.dropport.proxy";
export const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
export const SYSTEMD_UNIT = "/etc/systemd/system/dropport.service";
// A user agent, not a system daemon: publishing an mDNS name needs no privilege, and
// asking for root to do something root is not required for is how tools lose trust.
export const MDNS_LABEL = "dev.dropport.mdns";
export const MDNS_PLIST = resolve(homedir(), "Library", "LaunchAgents", `${MDNS_LABEL}.plist`);
// Root-owned so the daemon can write certificates; the local CA lives here too, which
// is why `trust` has to point at the same directory.
export const ADMIN_ADDR = "127.0.0.1:2019";
export const DATA_DIR = MAC ? "/Library/Application Support/dropport" : "/var/lib/dropport";

export function caddyPath() {
  for (const p of ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"]) {
    if (existsSync(p)) return p;
  }
  try {
    return execFileSync("which", ["caddy"], { stdio: "pipe" }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function readRegistry() {
  try {
    return normalise(JSON.parse(readFileSync(REGISTRY, "utf8")).apps);
  } catch {
    return [];
  }
}

export function writeRegistry(apps) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify({ apps: normalise(apps) }, null, 2) + "\n");
}

export function writeCaddyfile(apps, opts = {}, target = CADDYFILE) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buildCaddyfile(apps, opts));
  return target;
}

/** Run something as root, announcing it first so a password prompt is never a surprise. */
export function sudo(argv, { why }) {
  console.log(`  sudo: ${why}`);
  const r = spawnSync("sudo", argv, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`failed: sudo ${argv.join(" ")}`);
}

export function validateConfig() {
  const caddy = caddyPath();
  if (!caddy) throw new Error("caddy not found — install it first (brew install caddy)");
  const r = spawnSync(caddy, ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"], { stdio: "pipe" });
  return { ok: r.status === 0, output: (r.stdout?.toString() || "") + (r.stderr?.toString() || "") };
}

// --- hosts file --------------------------------------------------------------

export function hostsNeedsUpdate(apps) {
  let current = "";
  try {
    current = readFileSync(HOSTS_FILE, "utf8");
  } catch {
    return true;
  }
  return applyHostsLines(current, apps) !== current;
}

export function syncHosts(apps) {
  const current = readFileSync(HOSTS_FILE, "utf8");
  const next = applyHostsLines(current, apps);
  if (next === current) return false;
  if (process.env.DROPPORT_HOSTS_FILE) {
    writeFileSync(HOSTS_FILE, next); // scratch file in tests; no escalation needed
    return true;
  }
  const tmp = resolve(HOME_DIR, "hosts.staged");
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(tmp, next);
  // copy rather than edit in place, so a failure never leaves a half-written hosts file
  sudo(["cp", tmp, HOSTS_FILE], { why: `updating ${HOSTS_FILE} with your dropport hostnames` });
  if (MAC) {
    try {
      execFileSync("sudo", ["dscacheutil", "-flushcache"], { stdio: "ignore" });
      execFileSync("sudo", ["killall", "-HUP", "mDNSResponder"], { stdio: "ignore" });
    } catch {}
  }
  return true;
}

// --- the privileged service --------------------------------------------------

function plist(caddy) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${caddy}</string><string>run</string>
    <string>--config</string><string>${CADDYFILE}</string>
    <string>--adapter</string><string>caddyfile</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${DATA_DIR}</string>
    <key>XDG_DATA_HOME</key><string>${DATA_DIR}</string>
    <key>XDG_CONFIG_HOME</key><string>${DATA_DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA_DIR}/dropport.log</string>
  <key>StandardErrorPath</key><string>${DATA_DIR}/dropport.log</string>
</dict></plist>
`;
}

function unit(caddy) {
  return `[Unit]
Description=dropport local reverse proxy
After=network.target

[Service]
ExecStart=${caddy} run --config ${CADDYFILE} --adapter caddyfile
Environment=HOME=${DATA_DIR}
Environment=XDG_DATA_HOME=${DATA_DIR}
Environment=XDG_CONFIG_HOME=${DATA_DIR}
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;
}

export function installService() {
  const caddy = caddyPath();
  if (!caddy) throw new Error("caddy not found — install it first (brew install caddy)");
  const staged = resolve(HOME_DIR, MAC ? "service.plist" : "dropport.service");
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(staged, MAC ? plist(caddy) : unit(caddy));

  sudo(["mkdir", "-p", DATA_DIR], { why: `creating ${DATA_DIR} for certificates and logs` });
  if (MAC) {
    sudo(["cp", staged, PLIST], { why: `installing the launch daemon so it can bind 80 and 443` });
    sudo(["chown", "root:wheel", PLIST], { why: "launchd refuses a daemon it does not own" });
    spawnSync("sudo", ["launchctl", "bootout", "system", PLIST], { stdio: "ignore" }); // ignore: may not be loaded
    sudo(["launchctl", "bootstrap", "system", PLIST], { why: "starting the proxy" });
  } else {
    sudo(["cp", staged, SYSTEMD_UNIT], { why: "installing the systemd unit" });
    sudo(["systemctl", "daemon-reload"], { why: "picking up the new unit" });
    sudo(["systemctl", "enable", "--now", "dropport"], { why: "starting the proxy" });
  }
}

export function uninstallService() {
  if (MAC) {
    spawnSync("sudo", ["launchctl", "bootout", "system", PLIST], { stdio: "ignore" });
    sudo(["rm", "-f", PLIST], { why: "removing the launch daemon" });
  } else {
    spawnSync("sudo", ["systemctl", "disable", "--now", "dropport"], { stdio: "ignore" });
    sudo(["rm", "-f", SYSTEMD_UNIT], { why: "removing the systemd unit" });
    spawnSync("sudo", ["systemctl", "daemon-reload"], { stdio: "ignore" });
  }
}

// --- mDNS publisher (unprivileged) -------------------------------------------

const SUPERVISOR = resolve(new URL("../bin/dropport-mdns.mjs", import.meta.url).pathname);

export function mdnsInstalled() {
  return MAC ? existsSync(MDNS_PLIST) : false;
}

export function installMdns() {
  if (!MAC) return false; // Linux users can run the supervisor from their own init
  mkdirSync(resolve(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    MDNS_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MDNS_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${SUPERVISOR}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${resolve(HOME_DIR, "mdns.log")}</string>
  <key>StandardErrorPath</key><string>${resolve(HOME_DIR, "mdns.log")}</string>
</dict></plist>
`
  );
  // no sudo: gui/<uid> is this user's own launchd domain
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, MDNS_PLIST], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, MDNS_PLIST], { stdio: "pipe" });
  return r.status === 0;
}

export function uninstallMdns() {
  if (!MAC) return false;
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, MDNS_PLIST], { stdio: "ignore" });
  try { rmSync(MDNS_PLIST, { force: true }); } catch {}
  return true;
}

export function serviceInstalled() {
  return existsSync(MAC ? PLIST : SYSTEMD_UNIT);
}

/** Ask the running proxy to re-read its config, so adding an app needs no restart. */
export function reload() {
  const caddy = caddyPath();
  if (!caddy) return false;
  const r = spawnSync(caddy, ["reload", "--config", CADDYFILE, "--adapter", "caddyfile"], { stdio: "pipe" });
  return r.status === 0;
}

/**
 * Install Caddy's local CA into the system trust store. Must use the daemon's data
 * directory, or it would trust a different CA than the one actually serving.
 */
export function trustCa() {
  const caddy = caddyPath();
  if (!caddy) throw new Error("caddy not found");
  if (!serviceInstalled()) throw new Error("the proxy is not installed yet — run dropport up first");
  // caddy trust asks the running proxy for its CA over the admin API. The default
  // "localhost" resolves to ::1 first, while the admin endpoint binds IPv4 only, so
  // it fails with a bare "connection refused". Naming the address avoids the whole
  // dual-stack question.
  sudo(
    ["env", `HOME=${DATA_DIR}`, `XDG_DATA_HOME=${DATA_DIR}`, caddy, "trust", "--address", ADMIN_ADDR],
    { why: "adding the local certificate authority to your system trust store" }
  );
}

/** Is the proxy's certificate already accepted without --insecure? */
export async function certTrusted(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return true;
  } catch (e) {
    return !/certificate|self.signed|unable to (get|verify)|CERT_/i.test(String(e?.message || e));
  }
}

/**
 * Can we bind this port? lsof lies to a non-root user about other users' sockets, so
 * asking the kernel directly is the only answer you can trust.
 */
export function portInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "0.0.0.0");
  });
}

/**
 * Is OUR proxy the thing that is running? Its admin endpoint is the giveaway.
 *
 * Deliberately node:http and not fetch. Caddy's admin API refuses requests whose
 * Origin header it does not recognise, and undici sends an empty Origin where curl
 * and node:http send none at all — so fetch gets a 403 and the proxy looks dead
 * while it is serving perfectly well.
 */
export async function proxyRunning() {
  const [host, port] = ADMIN_ADDR.split(":");
  const http = (await import("node:http")).default;
  return new Promise((resolve) => {
    const req = http.get({ host, port: Number(port), path: "/config/", timeout: 2000 }, (res) => {
      res.resume();
      resolve((res.statusCode || 0) < 400);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

/** Ask the running proxy which ports it is actually bound to. */
export async function loadedPorts() {
  const [host, port] = ADMIN_ADDR.split(":");
  const http = (await import("node:http")).default;
  const body = await new Promise((resolve) => {
    const req = http.get({ host, port: Number(port), path: "/config/", timeout: 2000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(res.statusCode === 200 ? d : ""));
    });
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
  const out = new Set();
  try {
    const servers = JSON.parse(body)?.apps?.http?.servers || {};
    for (const srv of Object.values(servers)) {
      for (const addr of srv.listen || []) {
        const m = /:(\d+)$/.exec(String(addr));
        if (m) out.add(Number(m[1]));
      }
    }
  } catch {}
  return out;
}

/**
 * Global Caddyfile options that suit whatever else is already running.
 *
 * Ownership is per PORT, not per proxy. An earlier version treated "our proxy is
 * running" as "both ports are ours", which is false whenever we hold 443 while
 * something else holds 80 — and that is the normal case alongside OrbStack or Docker
 * Desktop. It made the generated config drop the port-80 workaround, and the daemon
 * then crash-looped on a port it could never have.
 */
export async function portOptions() {
  const [bound80, bound443] = await Promise.all([portInUse(80), portInUse(443)]);
  const ours = await proxyRunning();
  // A crash-looping Caddy still answers the admin API: it starts that endpoint before
  // it binds the listeners, so there is a window every restart where it is reachable
  // and reports the ports its config *wants* — including the :80 it cannot have. Take
  // that as ownership and the loop feeds itself: we decide we already hold :80, write
  // a config that binds :80, and fail again, forever, while `up` keeps saying "proxy
  // running". Serving 443 is this proxy's whole job, so one that is not holding it is
  // not serving, and gets no say in who owns what.
  const loaded = ours && bound443 ? [...(await loadedPorts())] : [];
  return portDecision({ bound80, bound443, adminUp: ours, loaded });
}

/** Wait for the proxy to actually answer after a start, rather than assuming it did. */
export async function waitForProxy(ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await proxyRunning()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The last line Caddy wrote that looks like the reason it gave up. */
export function lastServiceError() {
  try {
    const log = readFileSync(resolve(DATA_DIR, "dropport.log"), "utf8").split(/\r?\n/);
    for (let i = log.length - 1; i >= 0 && i > log.length - 400; i--) {
      const line = log[i].trim();
      if (line.startsWith("Error:") || /"level":"error"/.test(line)) return line.slice(0, 300);
    }
  } catch {}
  return "";
}

/**
 * Ask the proxy directly whether it serves a host, over the loopback address with the
 * hostname supplied as SNI. This deliberately skips DNS: resolving a .local name takes
 * five seconds on macOS and can fail outright from Node, which says nothing about
 * whether the proxy is working.
 */
export function probeHost(host, { tls = true, ms = 6000 } = {}) {
  return new Promise((resolve) => {
    const mod = tls ? "node:https" : "node:http";
    import(mod).then(({ default: lib }) => {
      const req = lib.request(
        {
          host: "127.0.0.1",
          port: tls ? 443 : 80,
          path: "/",
          method: "HEAD",
          servername: tls ? host : undefined,
          headers: { host },
          rejectUnauthorized: false, // trust is a separate question, asked separately
          timeout: ms,
        },
        (res) => {
          res.resume();
          resolve({ ok: true, status: res.statusCode });
        }
      );
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timed out" }); });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.end();
    });
  });
}

/** How long the OS takes to resolve a name. .local goes via mDNS and is often slow. */
export async function resolveMs(host) {
  const dns = await import("node:dns/promises");
  const t = Date.now();
  try {
    const a = await dns.lookup(host);
    return { ms: Date.now() - t, address: a.address };
  } catch (e) {
    return { ms: Date.now() - t, error: e.code || e.message };
  }
}

export async function probe(url, ms = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
