#!/usr/bin/env node
// Supervisor for the mDNS publishers. Run by launchd/systemd, not by hand.
//
// One publisher process per .local hostname, because a registration lasts exactly as
// long as the process holding it. Children are restarted if they die, and the registry
// is re-read when it changes so `dropport add` takes effect without a restart.
import { spawn } from "node:child_process";
import { watchFile } from "node:fs";
import { REGISTRY } from "../src/config.mjs";
import { mdnsHosts, publishCommand, mdnsSupported } from "../src/mdns.mjs";
import { readRegistry } from "../src/system.mjs";

if (!mdnsSupported()) {
  console.error("mdns: not supported on this platform");
  process.exit(1);
}

/** host -> child process currently publishing it */
const running = new Map();
let stopping = false;

function publish(host) {
  const cmd = publishCommand(host);
  if (!cmd) return;
  const child = spawn(cmd.bin, cmd.args, { stdio: "ignore" });

  child.on("exit", (code, signal) => {
    running.delete(host);
    if (stopping) return;
    // A publisher exiting means the name has silently stopped resolving, which looks
    // exactly like dropport being broken. Put it back.
    console.log(`mdns: ${host} publisher exited (${signal || code}), restarting`);
    setTimeout(() => { if (!stopping && wanted().includes(host)) publish(host); }, 1000);
  });

  child.on("error", (e) => {
    running.delete(host);
    console.error(`mdns: cannot publish ${host}: ${e.message}`);
  });

  running.set(host, child);
  console.log(`mdns: publishing ${host}`);
}

const wanted = () => mdnsHosts(readRegistry());

function reconcile() {
  const want = new Set(wanted());
  for (const host of want) if (!running.has(host)) publish(host);
  for (const [host, child] of running) {
    if (!want.has(host)) {
      console.log(`mdns: withdrawing ${host}`);
      child.kill();
      running.delete(host);
    }
  }
  if (!want.size) console.log("mdns: no .local hostnames registered; nothing to publish");
}

function shutdown() {
  stopping = true;
  for (const [, child] of running) child.kill();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

reconcile();
// polling rather than fs.watch: this file is replaced, not edited in place, and
// rename events are unreliable across platforms
watchFile(REGISTRY, { interval: 2000 }, reconcile);
