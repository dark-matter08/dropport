// The half of dropport that touches the machine: locating Caddy, writing the config,
// editing /etc/hosts, and installing the privileged service that can bind 80 and 443.
//
// Everything that needs root is funnelled through sudo() so there is exactly one place
// that escalates, and it always says what it is about to do first.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { HOME_DIR, CADDYFILE, REGISTRY, applyHostsLines, buildCaddyfile, normalise, portDecision } from "./config.mjs";

export const MAC = platform() === "darwin";
export const WIN = platform() === "win32";
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
export const DATA_DIR = MAC
  ? "/Library/Application Support/dropport"
  : WIN
    ? resolve(process.env.LOCALAPPDATA || homedir(), "dropport")
    : "/var/lib/dropport";
// Windows runs the proxy as a logon task in your own session rather than as a system
// service, so its data belongs under your profile — and needs no elevation to write.
export const WIN_TASK = "dropport proxy";
export const WIN_LAUNCHER = resolve(HOME_DIR, "run-caddy.cmd");
export const WIN_STARTUP_VBS = resolve(
  process.env.APPDATA || homedir(),
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "dropport.vbs"
);

export function caddyPath() {
  const candidates = WIN
    ? [
        // winget drops a shim here; scoop and chocolatey have their own
        resolve(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "caddy.exe"),
        resolve(homedir(), "scoop", "shims", "caddy.exe"),
        "C:\\ProgramData\\chocolatey\\bin\\caddy.exe",
        resolve(process.env.ProgramFiles || "C:\\Program Files", "Caddy", "caddy.exe"),
      ]
    : ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  try {
    const out = execFileSync(WIN ? "where" : "which", ["caddy"], { stdio: "pipe" }).toString();
    // `where` can return several lines; the first is the one that would run
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
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

  if (WIN) {
    // The one thing on Windows that still needs an administrator. Start-Process -Verb
    // RunAs raises the UAC prompt; -Wait so we do not carry on before it has happened,
    // and Copy-Item so a failure cannot leave a half-written hosts file.
    console.log(`  Windows will ask for administrator access, to update ${HOSTS_FILE}`);
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile", "-Command",
        `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ` +
          `'-NoProfile','-Command','Copy-Item -LiteralPath ''${tmp}'' -Destination ''${HOSTS_FILE}'' -Force'`,
      ],
      { stdio: "inherit" }
    );
    if (r.status !== 0) throw new Error(`could not update ${HOSTS_FILE} — administrator access was refused`);
    // Windows caches name lookups too, and a stale negative entry outlives the edit
    spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore" });
    return true;
  }

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
  mkdirSync(HOME_DIR, { recursive: true });
  const staged = resolve(HOME_DIR, MAC ? "service.plist" : "dropport.service");
  if (!WIN) writeFileSync(staged, MAC ? plist(caddy) : unit(caddy));

  if (WIN) {
    // Windows has no privileged-port concept: any process can bind 80 and 443 if they
    // are free. So this is a logon task in the user's own session rather than a system
    // service, and the only thing left that needs an administrator is the hosts file.
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      WIN_LAUNCHER,
      [
        "@echo off",
        `set "HOME=${DATA_DIR}"`,
        `set "XDG_DATA_HOME=${DATA_DIR}"`,
        `set "XDG_CONFIG_HOME=${DATA_DIR}"`,
        `"${caddy}" run --config "${CADDYFILE}" --adapter caddyfile >> "${resolve(DATA_DIR, "dropport.log")}" 2>&1`,
        "",
      ].join("\r\n")
    );
    spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"], { stdio: "ignore" }); // may not exist
    // /SC ONLOGON with no /RU registers a task that fires for *any* user, and that
    // needs elevation — it comes back "ERROR: Access is denied." Naming the current
    // user scopes it to this account, which does not.
    const who = process.env.USERNAME
      ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`
      : null;
    const args = ["/Create", "/TN", WIN_TASK, "/TR", `"${WIN_LAUNCHER}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"];
    if (who) args.push("/RU", who);
    const created = spawnSync("schtasks", args, { stdio: "pipe", encoding: "utf8" });

    if (created.status === 0) {
      spawnSync("schtasks", ["/Run", "/TN", WIN_TASK], { stdio: "ignore" });
      return;
    }

    // A locked-down machine can refuse task creation outright. The Startup folder is
    // a file in your own profile and always works; a one-line VBScript runs the
    // launcher hidden, so there is no console window at logon.
    console.log(`  the scheduled task was refused (${String(created.stderr || created.stdout || "").trim().split(/\r?\n/)[0]})`);
    console.log("  falling back to the Startup folder, which needs no permissions");
    mkdirSync(dirname(WIN_STARTUP_VBS), { recursive: true });
    writeFileSync(WIN_STARTUP_VBS, `CreateObject("WScript.Shell").Run """${WIN_LAUNCHER}""", 0, False\r\n`);
    spawnSync("wscript.exe", [WIN_STARTUP_VBS], { stdio: "ignore" });
    return;
  }

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
  if (WIN) {
    spawnSync("schtasks", ["/End", "/TN", WIN_TASK], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"], { stdio: "ignore" });
    rmSync(WIN_STARTUP_VBS, { force: true });
    rmSync(WIN_LAUNCHER, { force: true });
    return;
  }
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
  if (WIN) {
    if (spawnSync("schtasks", ["/Query", "/TN", WIN_TASK], { stdio: "ignore" }).status === 0) return true;
    return existsSync(WIN_STARTUP_VBS);
  }
  return existsSync(MAC ? PLIST : SYSTEMD_UNIT);
}

/** Ask the running proxy to re-read its config, so adding an app needs no restart. */
export function reload() {
  const caddy = caddyPath();
  if (!caddy) return false;
  const r = spawnSync(caddy, ["reload", "--config", CADDYFILE, "--adapter", "caddyfile"], { stdio: "pipe" });
  return r.status === 0;
}

// --- browser trust stores ----------------------------------------------------
//
// Browsers do not all read the system trust store. Chrome and Chromium on Linux keep
// their own NSS database under ~/.pki/nssdb, and Firefox keeps one per profile on
// every platform. `caddy trust` writes to them too — but only when it can find them,
// and dropport runs it under sudo with HOME pointed at the daemon's data directory,
// so what it actually finds is root's. The system store gets the certificate, curl
// is satisfied, and the browser goes on calling the site insecure.
//
// So we install it into the invoking user's stores ourselves, by name.

const NSS_NICK = "dropport local authority";

function onPath(bin) {
  return spawnSync(WIN ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

export function rootCertPath() {
  return resolve(DATA_DIR, "caddy", "pki", "authorities", "local", "root.crt");
}

/** The CA root in PEM, from the running proxy — the same place `caddy trust` reads it. */
async function fetchRootPem() {
  const [host, port] = ADMIN_ADDR.split(":");
  const http = (await import("node:http")).default;
  return new Promise((resolve) => {
    const req = http.get({ host, port: Number(port), path: "/pki/ca/local", timeout: 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).root_certificate || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/**
 * A copy of the CA root this user can read.
 *
 * Asked of the proxy rather than looked for on disk. Caddy keeps the authority under
 * its data directory with the private key beside it, so the directory is root-owned
 * and not traversable by the user running this — existsSync could not even stat the
 * file and answered "false", which came out as "the local certificate authority is
 * not on disk yet" on a machine where it was plainly on disk and already serving.
 *
 * The admin API hands it over with no privilege at all, and it is by definition the
 * authority actually in use rather than whatever a path happens to hold.
 */
async function readableRoot() {
  const pem = await fetchRootPem();
  if (pem) {
    const tmp = resolve(tmpdir(), "dropport-root.crt");
    writeFileSync(tmp, pem);
    return tmp;
  }
  // no proxy answering: fall back to the copy on disk, if this user can read it
  const src = rootCertPath();
  try {
    readFileSync(src);
    return src;
  } catch {
    return null;
  }
}

/** Every NSS database belonging to this user: Chromium's, and each Firefox profile. */
export function nssProfiles(home = homedir(), os = platform()) {
  const mac = os === "darwin";
  const win = os === "win32";
  const found = [];
  const chromium = resolve(home, ".pki", "nssdb");
  if (!win && !mac) found.push({ dir: chromium, kind: "chromium" });

  const firefoxRoots = mac
    ? [resolve(home, "Library", "Application Support", "Firefox", "Profiles")]
    : [
        resolve(home, ".mozilla", "firefox"),
        // snap and flatpak each keep their own home
        resolve(home, "snap", "firefox", "common", ".mozilla", "firefox"),
        resolve(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
      ];
  for (const base of firefoxRoots) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = resolve(base, entry);
      if (existsSync(resolve(dir, "cert9.db"))) found.push({ dir, kind: "firefox" });
    }
  }
  return found;
}

function ensureCertutil() {
  if (onPath("certutil")) return true;
  if (MAC) return false; // comes with `brew install nss`; not worth installing behind your back
  // Retry behind an update: on a rolling distribution stale package lists are normal,
  // and "Unable to locate package" is what they look like. One escalation, not two.
  const managers = [
    ["apt-get", "apt-get install -y libnss3-tools || (apt-get update && apt-get install -y libnss3-tools)"],
    ["dnf", "dnf install -y nss-tools"],
    ["pacman", "pacman -S --noconfirm nss"],
    ["zypper", "zypper install -y mozilla-nss-tools"],
  ];
  const mgr = managers.find(([bin]) => onPath(bin));
  if (!mgr) return false;
  try {
    sudo(["sh", "-c", mgr[1]], { why: "installing certutil, which is how a browser is told about a certificate" });
  } catch {
    return false;
  }
  return onPath("certutil");
}

/**
 * Put the CA root into this user's browser stores. Returns what happened rather than
 * throwing: the system store is already done by this point, and a browser that cannot
 * be reached is worth reporting, not worth failing the whole command over.
 */
export async function trustBrowsers() {
  const root = await readableRoot();
  if (!root) return { added: 0, skipped: [], note: "could not obtain the certificate authority — is the proxy running?" };

  const profiles = nssProfiles();
  if (!profiles.length) return { added: 0, skipped: [], note: "no browser certificate store found for your user" };
  if (!ensureCertutil()) {
    return {
      added: 0,
      skipped: profiles.map((p) => p.dir),
      note: MAC
        ? "certutil is missing — `brew install nss`, then run this again"
        : "certutil is missing and could not be installed — install libnss3-tools, then run this again",
    };
  }

  const added = [];
  const skipped = [];
  for (const { dir, kind } of profiles) {
    if (kind === "chromium" && !existsSync(resolve(dir, "cert9.db"))) {
      // Chrome creates this on first run; make it ourselves so trusting works before
      // the browser has ever been opened
      mkdirSync(dir, { recursive: true });
      spawnSync("certutil", ["-N", "--empty-password", "-d", `sql:${dir}`], { stdio: "ignore" });
    }
    const db = `sql:${dir}`;
    // drop any earlier copy first, or a re-issued CA leaves a stale one alongside
    spawnSync("certutil", ["-D", "-n", NSS_NICK, "-d", db], { stdio: "ignore" });
    const r = spawnSync("certutil", ["-A", "-t", "C,,", "-n", NSS_NICK, "-i", root, "-d", db], { stdio: "pipe" });
    (r.status === 0 ? added : skipped).push(dir);
  }
  return { added: added.length, skipped, profiles: added };
}

/** Is the CA in this user's browser stores? Answers what the browser will do. */
export function browserTrusted({ profiles = nssProfiles(), hasCertutil = onPath("certutil"), win = WIN } = {}) {
  if (win) return true; // Chrome and Edge read the Windows store certutil -addstore writes to
  if (!profiles.length) return true; // genuinely nothing to tell
  // Not "true" when certutil is missing. Without it nothing can have been installed
  // into a browser store, so the honest answer is no — and answering yes made `trust`
  // report success and skip the very step that installs certutil, on exactly the
  // machines that had none. The same shape of mistake this whole fix was about.
  if (!hasCertutil) return false;
  return profiles.some(
    ({ dir }) => spawnSync("certutil", ["-L", "-n", NSS_NICK, "-d", `sql:${dir}`], { stdio: "ignore" }).status === 0
  );
}

/**
 * Install Caddy's local CA into the system trust store. Must use the daemon's data
 * directory, or it would trust a different CA than the one actually serving.
 */
export async function trustCa() {
  const caddy = caddyPath();
  if (!caddy) throw new Error("caddy not found");
  if (!serviceInstalled()) throw new Error("the proxy is not installed yet — run dropport up first");

  if (WIN) {
    // -user, not the machine store: adding to your own store needs no administrator,
    // and Chrome and Edge read it. Firefox keeps its own store and will still warn —
    // the same as on macOS.
    const root = resolve(DATA_DIR, "caddy", "pki", "authorities", "local", "root.crt");
    if (!existsSync(root)) {
      throw new Error(`the local certificate authority is not there yet (${root}) — start the proxy once, then trust it`);
    }
    const r = spawnSync("certutil", ["-addstore", "-user", "Root", root], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("certutil could not add the certificate authority");
    return;
  }

  // caddy trust asks the running proxy for its CA over the admin API. The default
  // "localhost" resolves to ::1 first, while the admin endpoint binds IPv4 only, so
  // it fails with a bare "connection refused". Naming the address avoids the whole
  // dual-stack question.
  sudo(
    ["env", `HOME=${DATA_DIR}`, `XDG_DATA_HOME=${DATA_DIR}`, caddy, "trust", "--address", ADMIN_ADDR],
    { why: "adding the local certificate authority to your system trust store" }
  );

  // and now the stores the browsers actually read. The call above runs as root with
  // HOME redirected, so whatever it did for NSS it did for the wrong user.
  const browsers = await trustBrowsers();
  if (browsers.added) {
    console.log(`  told ${browsers.added} browser profile${browsers.added === 1 ? "" : "s"} about it`);
    console.log("  restart your browser for it to take effect");
  } else if (browsers.note) {
    console.log(`  note: ${browsers.note}`);
  }
}

/**
 * Is the proxy's certificate already accepted without --insecure?
 *
 * Asked of the SYSTEM, not of Node. Node ships its own CA bundle and does not read
 * the macOS keychain — the store `caddy trust` writes to — so its answer is about
 * Node's opinion rather than the browser's, and the browser's is the only one that
 * matters here. curl validates against the same store on macOS and Linux.
 *
 * The previous implementation asked Node AND misread the failure: node's fetch
 * reports every transport error as "fetch failed" and puts the real reason on
 * `.cause`, so matching on `.message` alone read a rejected certificate as a trusted
 * one. `trust` then said "already trusted — nothing to do" and skipped the work, on
 * exactly the machines that needed it.
 */
export async function certTrusted(url) {
  const r = spawnSync("curl", ["-sS", "-o", "/dev/null", "--max-time", "8", url], { encoding: "utf8" });
  if (!r.error) return r.status === 0;

  // no curl on this box: fall back to Node, reading the cause this time
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return true;
  } catch (e) {
    const why = [e?.message, e?.code, e?.cause?.message, e?.cause?.code].filter(Boolean).join(" ");
    return !/certificate|self.signed|self-signed|unable to (get|verify)|CERT_|DEPTH_ZERO/i.test(why);
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
