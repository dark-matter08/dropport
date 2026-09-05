// The half of dropport that touches the machine: locating Caddy, writing the config,
// editing /etc/hosts, and installing the privileged service that can bind 80 and 443.
//
// Everything that needs root is funnelled through sudo() so there is exactly one place
// that escalates, and it always says what it is about to do first.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { HOME_DIR, CADDYFILE, REGISTRY, applyHostsLines, buildCaddyfile, normalise } from "./config.mjs";

export const MAC = platform() === "darwin";
// Overridable so the whole flow can be exercised against a scratch file in tests
// rather than requiring root and mutating the real one.
export const HOSTS_FILE =
  process.env.DROPPORT_HOSTS_FILE ||
  (platform() === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts");
export const LABEL = "dev.dropport.proxy";
export const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
export const SYSTEMD_UNIT = "/etc/systemd/system/dropport.service";
// Root-owned so the daemon can write certificates; the local CA lives here too, which
// is why `trust` has to point at the same directory.
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

export function writeCaddyfile(apps, opts = {}) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CADDYFILE, buildCaddyfile(apps, opts));
  return CADDYFILE;
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
  sudo(["env", `HOME=${DATA_DIR}`, `XDG_DATA_HOME=${DATA_DIR}`, caddy, "trust"], {
    why: "adding the local certificate authority to your system trust store",
  });
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

/** Global Caddyfile options that suit whatever else is already running. */
export async function portOptions() {
  const [http80, https443] = await Promise.all([portInUse(80), portInUse(443)]);
  return { disableRedirects: http80, httpsBlocked: https443, http80, https443 };
}

export async function probe(url, ms = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
