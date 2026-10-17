# Running it permanently on a small box

The laptop setup in the README is fine for trying this out, but a venue that
runs trivia every week wants a box in a cupboard that just works: starts on
boot, comes back by itself if it falls over, and nobody has to remember a
command.

Any Linux machine with systemd does the job. The server idles around 50 MB of
RAM and has no native dependencies, so the floor is low — a **Raspberry Pi Zero
2 W** is enough for a room of twenty teams. A Pi 4, Pi 5, Jetson or any mini PC
is comfortable.

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

```powershell
git clone https://github.com/gmdeckard/primetime-trivia.git
cd primetime-trivia
.\start-server.ps1
```

`start-server.ps1` rebuilds when sources are newer than the last build, same
rule as the bash script, and leaves the previous build in place if the build
fails. Stop it with Ctrl+C. Players join at the LAN address it prints; the big
screen uses the localhost one.

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
rather use a high port, set `PORT=8080` in the config and restart.

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
