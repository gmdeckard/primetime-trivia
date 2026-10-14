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
the systemd unit, and starts it. It prints the join URLs and the host PIN when
it finishes.

It's safe to re-run — that's also how you update:

```bash
cd ~/primetime-trivia && sudo ./scripts/install-service.sh
```

Re-running pulls the latest code, rebuilds and restarts, and **leaves your
config and host PIN alone**.

## Configuration

Settings live in `/etc/default/primetime-trivia`:

```bash
PORT=80
PRIMETIME_VENUE=Thursday Trivia
PRIMETIME_PIN=297392
PRIMETIME_DATA=/home/pi/primetime-trivia/data
#PRIMETIME_SSID=Clubhouse-Guest
```

After editing:

```bash
sudo systemctl restart primetime-trivia
```

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
