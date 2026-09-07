import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
