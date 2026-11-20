# Running it permanently on a small box

The laptop setup in the README is fine for trying this out, but a venue that
runs trivia every week wants a box in a cupboard that just works: starts on
boot, comes back by itself if it falls over, and nobody has to remember a
command.

Any Linux machine with systemd does the job, and there are no native
dependencies. Measured against the real question bank: the server idles at
**119 MB** of RAM and peaks at **121 MB** with a hundred players all answering,
so a hundred players cost under 3 MB over idle. The Node baseline and the
question bank are the whole footprint, and the number of players barely moves
it. Wire cost is about 0.9 KB per player per question, so a sixty-question night
with a hundred phones is roughly 13 MB of traffic in total.

That means a **Raspberry Pi Zero 2 W** (512 MB) still fits with room to spare,
and a Pi 4, Pi 5, Jetson or any mini PC is comfortable. Size a box for 1 GB and
stop thinking about it.

**Not an Arduino or ESP32.** Those are microcontrollers with no operating
system; they can't run Node, a filesystem, or twenty websockets.

## Install

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/gmdeckard/primetime-trivia.git
cd primetime-trivia
sudo ./scripts/install-service.sh
```

The script installs Node if it's missing, builds, writes a config file, installs
the systemd unit, and starts it. It prints the join URLs and the host password
when it finishes.

It's safe to re-run — that's also how you update:

```bash
cd ~/primetime-trivia && sudo ./scripts/install-service.sh
```

Re-running pulls the latest code, rebuilds and restarts, and **leaves your
config and host password alone**.

### Updating a box you start by hand

If you skipped the service and run `./start-server.sh` yourself:

```bash
cd ~/primetime-trivia && git pull && ./stop-server.sh && ./start-server.sh
```

`dist/` is not in git, so a pull brings source only. `start-server.sh` notices
when any source is newer than the last build and rebuilds before starting, so
the pull above is enough. If the build fails it says so and leaves the previous
build in place, which means the box still starts and still runs last night's
version — check the output rather than assuming a silent success.

The quickest way to tell which version is actually running is the banner: it
prints `Host password` on current builds and `Host PIN` on anything older.

## Running it on the Windows laptop instead

The Jetson is one way to do this. The other is to run the server on the same
laptop that drives the TV, which is simpler and, on a workstation, faster than
the Jetson by a wide margin.

It also fixes something the two-box arrangement cannot. The browser's Screen
Wake Lock only works in a secure context. `http://localhost` counts as one;
`http://192.168.1.40` does not. With the server on another machine the big
screen is always on a LAN address, so the page can never hold the screen awake
and staying awake is a Windows display setting. Serve and view on the same
laptop, open the host screen at `http://localhost:8080/host`, and the page
keeps itself awake.

Run it from inside WSL, not from Windows itself:

```bash
git clone https://github.com/gmdeckard/primetime-trivia.git
cd primetime-trivia
./start-server.sh
```

`start-server.sh` rebuilds when sources are newer than the last build and
leaves the previous build in place if the build fails. Stop it with Ctrl+C.
Players join at the LAN address it prints; the big screen uses the localhost
one.

**If you use WSL, clone from inside it.** Cloning with Windows git into
`/mnt/c/...` and then running the scripts from WSL fails with

```
env: 'bash\r': No such file or directory
```

which names a program nobody typed. Git for Windows rewrites line endings on
checkout, so the shebang becomes `#!/usr/bin/env bash\r`. The repo's
`.gitattributes` forces LF on the shell scripts to prevent this, but an older
clone made before that still carries CRLF — `sed -i 's/\r$//' *.sh` repairs one
in place. Cloning into `~` from inside WSL avoids it entirely, and is also much
faster: `npm install` and `vite build` touch thousands of small files, and
every one of them crosses the filesystem boundary under `/mnt/c`.

**Three things decide whether this works on the night.**

**The firewall.** Windows blocks inbound connections to Node by default, and
blocks nearly everything when the network is classified Public. The start
script warns about both. To allow it once, in an Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName 'PrimeTime Trivia' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private
```

Then set the venue wifi to Private under Settings > Network & internet. Test
from a phone before the room arrives, not at seven o'clock.

**Sleep.** The server dies with the laptop. Set it never to sleep on AC power,
and if the lid will be closed while it drives the TV, set the lid-close action
to do nothing.

**The address it advertises.** A workstation with Hyper-V, WSL, Docker or
VirtualBox installed has several private addresses and only one the room can
reach. Both start scripts now ask which one to use when there is more than one
candidate, listing each with the adapter it sits on and a warning on the ones
phones cannot reach:

```
  Which address will the phones use?
    1) 172.16.0.42      wlp0s20f3
    2) 172.17.0.1       docker0          virtual adapter (container/VM/VPN) — phones cannot reach it
    o) something else — type an address

  Pick 1-2, o, or Enter for 1:
```

Enter takes the top-ranked guess. The list comes from the server itself, so it
is the same ranking the banner and the QR code use.

The prompt only appears with a terminal attached: the systemd service, cron and
any scripted start take the automatic pick silently. To skip it when you are
there, set `PRIMETIME_NO_PICK=1`, or pin the address outright and the prompt
does not appear:

```powershell
$env:PRIMETIME_HOST_IP = '192.168.1.40'
```

Give the laptop a DHCP reservation on the router so that address survives
between nights.

**Why a prompt and not just better ranking.** Ranking can only guess. A venue
on `172.16.0.x` shares its address band with Docker's bridges, so no scoring
rule can be sure which of them the phones are on. The operator is standing in
the room and knows.

**One difference from Linux.** `data/control-password` is written with mode
0600, which on Windows only toggles the read-only bit — the file is not
owner-only the way it is on Linux. For a laptop one person carries, that is
fine; it is worth knowing before putting a password there you use elsewhere.

## Configuration

Settings live in `/etc/default/primetime-trivia`:

```bash
PORT=80
PRIMETIME_VENUE=Thursday Trivia
PRIMETIME_PASSWORD=brass-lantern-42
PRIMETIME_DATA=/home/pi/primetime-trivia/data
#PRIMETIME_SSID=Clubhouse-Guest
# Only for a box reached from the internet — see the tunnel section below.
#PRIMETIME_BIND=127.0.0.1
#PRIMETIME_PUBLIC_URL=https://trivia.example.com
```

After editing:

```bash
sudo systemctl restart primetime-trivia
```

`PRIMETIME_PASSWORD` is what the MC types to open `/control` and `/author`. It
is set once here and does not change between games, so the MC types it when
they pick up a new phone rather than before every night. Changing it and
restarting signs every device out.

If you leave it unset, the server generates one on first start and saves it to
`data/control-password`, which keeps it stable across restarts; edit that file
to choose your own. The old `PRIMETIME_PIN` still works and logs a deprecation
notice at start-up.

Set `PRIMETIME_SSID` to the wifi network name and the join screen will tell
people which network to connect to before showing them the address — worth
doing, it removes the most common "it doesn't work" at the start of a night.

## Why port 80

The install defaults to port 80, so the join address is `http://192.168.1.42`
with nothing after it. That matters more than it sounds: you will be reading
it aloud to a room, and printing it on table cards. `:8080` is one more thing
to get wrong.

The service still runs as an unprivileged user. It binds the low port through
`AmbientCapabilities=CAP_NET_BIND_SERVICE` rather than running as root. If you'd
rather use a high port, set `PORT=8080` in the config and re-run the install
script, which then grants no port-binding capability at all.

**A box behind a tunnel wants port 8080, not 80.** Nobody reads that address
aloud — the public hostname is the only address anyone sees — so there is no
reason to bind a privileged port or hold a capability for it. See the tunnel
section below.

## Give it a fixed address

The join address is printed on the big screen and the QR code encodes it, so a
changing IP is a nuisance. Two options:

**Reserve it on the router** (preferred). Find the box's MAC address and add a
DHCP reservation. All the config stays in one place.

**Or set it statically** with NetworkManager:

```bash
nmcli con show                       # find the connection name
sudo nmcli con mod "<name>" ipv4.method manual \
  ipv4.addresses 192.168.1.42/24 \
  ipv4.gateway 192.168.1.1 \
  ipv4.dns "192.168.1.1,1.1.1.1"
sudo nmcli con up "<name>"
```

If you set it statically, make sure the address is **outside the router's DHCP
pool**, or a tablet will eventually be handed the same address and you'll get a
conflict that looks like random network failure on trivia night.

## Reaching it from the internet: a Cloudflare Tunnel

Everything above puts the box on the venue's LAN, which is the right answer
until the venue's wifi has **client isolation** turned on. Then no amount of
configuration helps: the phones and the box are on the same network and cannot
see each other, with no error that says so. The fix is to stop asking the phones
to reach the box locally and put the box on the internet instead, so the phones
go out and come back in. Isolation does not stop that.

A tunnel is the cheap way to do it. `cloudflared` dials **out** from the box and
holds the connection open, so:

- No inbound ports are opened at home and no router is reconfigured.
- It works behind CGNAT, where no port forward would have worked at all.
- TLS is handled at the edge, so there is no certificate to renew on the box.
- A changing home IP does not matter.
- The box can stay home. The venue needs internet and a browser, nothing else.

Websockets ride a tunnel with no extra configuration, which matters here because
the entire game is websockets.

### Set it up once

Install `cloudflared`. On arm64 (Jetson, Pi) the published `.deb` is the
reliable route, since Cloudflare's apt repo does not cover every Ubuntu
codename:

```bash
curl -fL -o /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

On x86-64 swap `arm64` for `amd64` in that URL.

Authenticate, create the tunnel, and point a hostname at it. The first command
prints a URL to open in a browser and asks which zone to use:

```bash
cloudflared tunnel login
cloudflared tunnel create trivia
cloudflared tunnel route dns trivia trivia.example.com
```

`route dns` writes the CNAME itself, so the Cloudflare DNS panel is never
touched by hand. `tunnel create` prints a UUID and writes a credentials file;
both are needed next.

Write the config. Keeping the credentials under `/etc/cloudflared` rather than
in a home directory means the service can read them at boot without depending on
`/home` being mounted:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json
ingress:
  - hostname: trivia.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF
cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
```

The trailing `http_status:404` is a catch-all: anything arriving for a hostname
you did not configure gets a flat 404 instead of reaching the game.

Run it in the foreground once to prove it works, then install it as a service:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel run trivia   # Ctrl-C when happy
sudo cloudflared service install
```

### Then change three settings on the game side

In `/etc/default/primetime-trivia`:

```bash
PORT=8080
PRIMETIME_BIND=127.0.0.1
PRIMETIME_PUBLIC_URL=https://trivia.example.com
```

Each one earns its place. `PORT=8080` because no human reads this address, so
there is no reason to bind a privileged port. `PRIMETIME_BIND=127.0.0.1` closes
the plain-HTTP port to everything except the tunnel, so the LAN cannot reach an
unencrypted copy of the game. `PRIMETIME_PUBLIC_URL` is the only address the
big screen, the QR code and the join panel will show — without it the server
advertises a private address that no phone at the venue can dial.

Restart and the banner should say `Serving behind https://… Local detection is
not in use.`

### A box that answers on two names

Two boxes that can each run the night want two names, and either box may end up
answering on either one — a tunnel hostname is a DNS record, so moving a name
from one box to the other is an edit in one place and no reinstall anywhere.

List every name a box answers on, comma separated:

```bash
PRIMETIME_PUBLIC_URL=https://trivia.example.com, https://trivia2.example.com
```

Then add both to that box's tunnel ingress, pointing at the same service:

```yaml
ingress:
  - hostname: trivia.example.com
    service: http://127.0.0.1:8080
  - hostname: trivia2.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Each screen is told the name it was itself opened with. That is the whole point:
the QR code on the big screen is scanned by a room standing in front of it, so
it has to send them to the address the operator is already using and not to
whichever name happens to be first in the config. Open `/host` on either name
and the code under it agrees with the address bar above it.

The first name is canonical — the start-up banner leads with it, and anything
with no request to read gets it. A name that is not in the list gets the
canonical one rather than itself, so a forged `Host` header cannot put somebody
else's domain into that QR code.

Check both, which is one command each:

```bash
curl -s http://127.0.0.1:8080/api/info -H 'Host: trivia.example.com'  # want that name back
curl -s http://127.0.0.1:8080/api/info -H 'Host: trivia2.example.com' # want that one back
```

### Check it properly

```bash
curl -si https://trivia.example.com/ | head -1          # want HTTP/2 200
curl -s -o /dev/null -w '%{http_code}\n' http://<box-lan-ip>:8080/   # want a refusal
```

Then the one that actually decides whether the game works:

```bash
curl -si --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
  -H 'Sec-WebSocket-Version: 13' \
  https://trivia.example.com/ws | head -1
```

Want `HTTP/1.1 101 Switching Protocols`. **`--http1.1` is not optional**: left
to itself curl negotiates HTTP/2, which cannot carry a classic websocket upgrade
and answers 404, which looks exactly like a broken tunnel and is not one.
Browsers get this right by themselves.

### Two things that bite

**HTTP 530 means no tunnel is connected.** It comes from Cloudflare, not from
the game, so the box may be perfectly healthy. Check
`systemctl status cloudflared` first.

**The night now depends on the venue's internet.** That was already true of any
internet-hosted setup, but it is worth saying plainly: if the rec center's uplink
is down there is no game, and the fallback is the local-network setup in
[HOSTING.md](HOSTING.md) with a travel router in the bag.

## Day to day

```bash
systemctl status primetime-trivia       # is it up
journalctl -u primetime-trivia -f       # watch the logs
sudo systemctl restart primetime-trivia # after a config change
sudo systemctl stop primetime-trivia    # shut it down
```

The game survives a restart. Teams, scores and which questions have been used
are written to disk on every transition, so a power cut costs you at most the
question that was on screen — the MC reveals it and carries on.

## Taking the whole thing to the clubhouse

If the venue has no usable wifi, or its guest network has **client isolation**
turned on (which silently blocks devices from reaching each other and breaks
everything with no useful error), bring your own network.

Simplest: a travel router. Plug the box into it by ethernet, reserve the box's
address, and you have the same SSID and the same join URL every week — so the
printed QR code on the table cards never stops working.

Some boards can be the access point themselves, which removes one device from
the bag. Test that thoroughly with a roomful of real devices before relying on
it; wifi chipset AP support varies, and discovering a limit at 6:45pm with
ninety people waiting is not the moment.

## Being the wifi instead of joining it

If the venue has no usable wifi — or its guest network has client isolation
turned on, which silently blocks devices from reaching each other — the box can
be the access point itself.

```bash
sudo ./scripts/network-mode.sh ap        # become an access point
sudo ./scripts/network-mode.sh client    # rejoin your normal wifi
sudo ./scripts/network-mode.sh status
```

Set the network name and password when you first switch:

```bash
sudo AP_SSID="Thursday Trivia" AP_PASS="snowbird2026" ./scripts/network-mode.sh ap
```

The access point always uses **192.168.50.1**, so the join address never
changes. Print the QR code once and it works every week.

### Know these three things first

**You lose internet in AP mode.** Most wifi chipsets cannot be an access point
and a client at the same time, and the Realtek part in the Jetson Orin Nano is
one of them. While the box is the AP there is no `git pull`, no `apt`, and the
`/author` screen cannot reach the Claude API. Switch to client mode to update,
then switch back.

**You can always get back in over USB-C.** The box runs a USB network gadget at
`192.168.55.1` that is completely independent of wifi. If an AP config leaves
you locked out, plug a USB-C cable into your laptop and `ssh g@192.168.55.1`.
No monitor, no keyboard. Know this before you experiment.

**Test it with real devices before you rely on it.** Vendor wifi drivers vary
enormously in how well they hold up as access points under load. Advertising AP
mode is not the same as serving forty tablets for an hour. Get twenty real
devices on it and run a full block before trusting it on a night, and keep a
travel router in the bag as the fallback. The software does not care which
network it is on.

### 2.4 or 5 GHz

The switcher defaults to **2.4 GHz** (`AP_BAND=bg`). It is slower and more
congested, but it carries further through clubhouse walls and works with older
tablets. Throughput is not the constraint here — the game sends a few kilobytes
per device per question — so range and compatibility win.

If your room is small and every device is modern, 5 GHz is cleaner:

```bash
sudo AP_BAND=a ./scripts/network-mode.sh ap
```
