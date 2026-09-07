import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nssProfiles } from "../src/system.mjs";

test("caddy is looked for where each Windows installer puts it", async () => {
  // winget, scoop and chocolatey all put it somewhere different, and none of them is
  // on PATH for a process that started before the install finished — the same trap
  // that made the Ledger's installer report git as missing right after installing it.
  const src = await readFile(new URL("../src/system.mjs", import.meta.url), "utf8");
  for (const marker of ["WinGet", "scoop", "chocolatey", "Program Files"]) {
    assert.ok(src.includes(marker), `caddyPath should look in ${marker}`);
  }
  // `where`, not `which`: there is no which on Windows
  assert.ok(src.includes('WIN ? "where" : "which"'), "must use where on Windows");
});

test("windows never falls into the systemd branch", async () => {
  // Before this, MAC was the only platform constant, so Windows took the else arm and
  // would have run `sudo cp` into /etc/systemd/system and `sudo systemctl` on a machine
  // that has none of them.
  const src = await readFile(new URL("../src/system.mjs", import.meta.url), "utf8");
  const install = src.slice(src.indexOf("export function installService"));
  const win = install.indexOf("if (WIN)");
  const mac = install.indexOf("if (MAC)");
  assert.ok(win >= 0, "installService needs a Windows arm");
  assert.ok(win < mac, "the Windows arm must come first, and return before the unix paths");
});

test("browser certificate stores are found wherever the browser keeps them", () => {
  // Chrome and Chromium on Linux keep their own NSS database, and Firefox keeps one
  // per profile on every platform. `caddy trust` is run under sudo with HOME pointed
  // at the daemon's data directory, so it looks for these in root's home and finds
  // nothing — the system store gets the CA, curl is satisfied, and the browser still
  // calls the site insecure. Finding them for the right user is the whole fix.
  const home = mkdtempSync(join(tmpdir(), "dropport-home-"));

  const ff = join(home, ".mozilla", "firefox", "abc123.default-release");
  mkdirSync(ff, { recursive: true });
  writeFileSync(join(ff, "cert9.db"), "");

  const snap = join(home, "snap", "firefox", "common", ".mozilla", "firefox", "xyz.default");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "cert9.db"), "");

  // a profile directory with no cert9.db is not a profile
  mkdirSync(join(home, ".mozilla", "firefox", "Crash Reports"), { recursive: true });

  const found = nssProfiles(home, "linux");
  const dirs = found.map((f) => f.dir);

  assert.ok(dirs.includes(ff), "the default Firefox profile");
  assert.ok(dirs.includes(snap), "and the one snap keeps in its own home");
  assert.ok(!dirs.some((d) => d.endsWith("Crash Reports")), "a directory without cert9.db is not a profile");

  assert.ok(
    dirs.includes(join(home, ".pki", "nssdb")),
    "Chromium's store is included even before it exists — trust can run before the browser has ever opened"
  );

  // macOS keeps Firefox somewhere else entirely, and has no Chromium NSS store at all
  const mac = nssProfiles(home, "darwin");
  assert.equal(mac.length, 0, "the Linux layout is not looked for on macOS");
  assert.ok(
    !mac.some((f) => f.kind === "chromium"),
    "Chrome on macOS reads the keychain, so there is no NSS store to write"
  );

  rmSync(home, { recursive: true, force: true });
});

test("every spelling of version answers, and answers the truth", async () => {
  const { execFileSync } = await import("node:child_process");
  const cli = new URL("../bin/dropport.mjs", import.meta.url).pathname;
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  // "unknown command --version" for the most reflexive thing anyone types is a small
  // insult repeated daily. All four spellings, because people reach for all four.
  for (const flag of ["version", "--version", "-v", "-V"]) {
    const out = execFileSync(process.execPath, [cli, flag], { encoding: "utf8" }).trim();
    assert.equal(out, version, `dropport ${flag}`);
  }

  // read from package.json, never a second copy: a version command that lies is worse
  // than not having one
  const src = await readFile(new URL("../bin/dropport.mjs", import.meta.url), "utf8");
  assert.match(src, /package\.json/, "the version must come from package.json");
});
