// Make .local hostnames resolve instantly, the way OrbStack's *.orb.local does.
//
// A .local lookup on macOS is answered by multicast DNS, never by /etc/hosts first.
// When nothing on the network answers, the resolver waits out the full timeout — about
// five seconds — and only then falls back to the hosts file. So a hosts entry alone
// gets you the right address, slowly. Measured on macOS 15:
//
//   name nothing answers for   5009ms
//   same name, published       3-9ms
//
// The fix is not a faster lookup, it is making something answer. We register the name
// with the system's own responder (Bonjour on macOS, Avahi on Linux) rather than
// implementing mDNS ourselves: they already hold port 5353 and get the protocol right.
//
// Registrations live only as long as the publishing process, which is why this needs a
// supervisor rather than a one-off command.
import { platform } from "node:os";

/** Only .local goes through mDNS. Publishing anything else would be noise. */
export function needsMdns(host) {
  return /\.local$/i.test(String(host || ""));
}

export function mdnsHosts(apps) {
  return (apps || []).filter((a) => needsMdns(a.host)).map((a) => a.host);
}

/**
 * The command that publishes one hostname, and keeps it published until killed.
 *
 * macOS: dns-sd -P registers a proxy record, which is the one form that publishes an
 * address for a host we are not ourselves named after.
 * Linux: avahi-publish -a does the same in one step.
 */
export function publishCommand(host, ip = "127.0.0.1", os = platform()) {
  const label = String(host).split(".")[0] || "dropport";
  if (os === "darwin") {
    return { bin: "dns-sd", args: ["-P", label, "_http._tcp", "local", "443", host, ip] };
  }
  if (os === "linux") {
    return { bin: "avahi-publish", args: ["-a", "-R", host, ip] };
  }
  return null; // Windows has no equivalent worth pretending about
}

export function mdnsSupported(os = platform()) {
  return os === "darwin" || os === "linux";
}
