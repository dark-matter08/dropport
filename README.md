# dropport

Reach your local dev servers at real hostnames, over HTTPS, with no port numbers.

```bash
dropport add myapp.test 5173
dropport up
open https://myapp.test
```

No `:5173`. No certificate warning. It keeps working after you reboot.

## Why

Local development ends up as a pile of port numbers you have to remember, and anything
that needs HTTPS — secure cookies, service workers, OAuth redirects, `SameSite=None`,
the Clipboard API — either doesn't work or needs a self-signed certificate you click
through every time.

Tools like OrbStack solve this nicely for containers. dropport does the same trick for
whatever you're already running: **a privileged reverse proxy on 80/443, a locally
trusted certificate authority, and the hosts entries to match.**

It is a thin wrapper around [Caddy](https://caddyserver.com), which does the hard parts.
dropport owns the registry, the generated config, the hosts file and the service.

## Install

```bash
brew install caddy          # or see caddyserver.com/docs/install
npm install -g dropport
```

Or straight from source, no registry involved:

```bash
npm install -g github:dark-matter08/dropport
```

Caddy is a hard requirement — dropport generates its config and manages its service,
but does the proxying and certificate work through it.

## Use

```bash
dropport add myapp 5173          # -> https://myapp.dp.local
dropport add api.test 8000       # a name with a dot is taken as given
dropport up                      # install and start the proxy
dropport trust                   # trust the local CA, so https is clean

dropport list                    # what is registered
dropport status                  # is it working
dropport doctor                  # why is it not working
dropport rm myapp.test
dropport down
```

Adding an app while the proxy is running reloads it in place. No restart.

## What needs root, and why

Three things, each announced before it runs:

| Why | What |
|---|---|
| Bind ports 80 and 443 | a launchd daemon (macOS) or systemd unit (Linux) |
| Point a hostname at 127.0.0.1 | one tagged line per app in `/etc/hosts` |
| HTTPS with no warning | Caddy's local CA added to your system trust store |

Nothing else escalates. Hosts edits are staged to a temp file and copied in, so a
failure can't leave you with a half-written `/etc/hosts`, and lines dropport didn't
write are never touched.

## Hostnames

**Bare names are expanded**: `dropport add shop` registers `shop.dp.local`. That is the
recommended form, and dropport publishes it over mDNS so it resolves instantly.

**Bare `.local` names are refused.** `.local` is multicast DNS
([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)) — a namespace every device on your
network answers into, and single-label names there are exactly what printers, phones and
other Macs use. Claiming `printer.local` means competing with a real printer, on some
networks and not others, which is a miserable bug to chase. dropport suggests
`printer.dp.local` instead, and `--force` is there if you truly mean it.

**`.test` also works well** and skips multicast entirely. It is reserved for local
development by [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761), so nothing competes
for it and no publisher is needed.

Avoid **`.dev`** and **`.app`** — real public TLDs with HSTS preloaded. They work
locally, but you are shadowing a name someone else owns.

## Why .local is normally slow, and why it is not here

A `.local` lookup is answered by multicast DNS, never by the hosts file first. When
nothing answers, the resolver waits out its full timeout before falling back. The tell
is that a name which does not exist at all takes just as long as one that does:

```
name nothing answers for     5009ms
same name, published          3-9ms
```

That is how OrbStack's `*.orb.local` feels instant — not a faster lookup, but a
responder that replies. dropport publishes its own `.local` names the same way, through
Bonjour on macOS and Avahi on Linux, supervised so a registration outlives the command
that created it.

## How it works

```
~/.dropport/apps.json     the registry you edit through the CLI
~/.dropport/Caddyfile     generated from it — edits here are overwritten
/etc/hosts                one tagged line per app
```

The generated Caddyfile is deliberately boring:

```
{
	local_certs
}

myapp.test {
	reverse_proxy 127.0.0.1:5173
}
```

`local_certs` is the load-bearing line. Without it Caddy tries to get a public
certificate from Let's Encrypt for a name that can never be validated, and fails on
every start.

## Requirements

Node 20+, and Caddy on your PATH. macOS and Linux. Windows can generate the config, but
service installation and hosts edits are manual.

## Licence

MIT
