import { test } from "node:test";
import assert from "node:assert/strict";
import { mdnsHosts, needsMdns, mdnsSupported, publishCommand } from "../src/mdns.mjs";

test("only .local names go through mDNS", () => {
  assert.ok(needsMdns("myapp.local"));
  assert.ok(needsMdns("MyApp.LOCAL"), "case does not matter");
  // these resolve through ordinary DNS and the hosts file; publishing them would be
  // noise at best, and a second answer competing with DNS at worst
  for (const h of ["myapp.test", "myapp.localhost", "myapp.dev", "local.com", ""]) {
    assert.ok(!needsMdns(h), h);
  }
});

test("only the .local subset of the registry is published", () => {
  const apps = [
    { host: "a.local", port: 1 },
    { host: "b.test", port: 2 },
    { host: "c.local", port: 3 },
  ];
  assert.deepEqual(mdnsHosts(apps), ["a.local", "c.local"]);
  assert.deepEqual(mdnsHosts([]), []);
  assert.deepEqual(mdnsHosts(undefined), []);
});

test("each platform gets the right publish command, or an honest null", () => {
  const mac = publishCommand("myapp.local", "127.0.0.1", "darwin");
  assert.equal(mac.bin, "dns-sd");
  // -P is the proxy form: the one that publishes an address for a host we are not named after
  assert.equal(mac.args[0], "-P");
  assert.ok(mac.args.includes("myapp.local") && mac.args.includes("127.0.0.1"));

  const linux = publishCommand("myapp.local", "127.0.0.1", "linux");
  assert.equal(linux.bin, "avahi-publish");
  assert.ok(linux.args.includes("-a") && linux.args.includes("myapp.local"));

  assert.equal(publishCommand("myapp.local", "127.0.0.1", "win32"), null, "no pretending on Windows");
  assert.ok(mdnsSupported("darwin") && mdnsSupported("linux") && !mdnsSupported("win32"));
});
