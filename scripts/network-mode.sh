#!/usr/bin/env bash
#
# Switch the box between joining your wifi and being the wifi.
#
#   sudo ./scripts/network-mode.sh ap        # become an access point
#   sudo ./scripts/network-mode.sh client    # rejoin the home/clubhouse wifi
#   sudo ./scripts/network-mode.sh status
#
# In AP mode the box has no internet: this wifi chipset cannot be an access
# point and a client at the same time. Switch to client mode to update.
#
# If a switch ever leaves you locked out, plug a USB-C cable into the Jetson and
# ssh to 192.168.55.1 — that link is independent of wifi.
set -euo pipefail

MODE="${1:-status}"
AP_CON="primetime-ap"
AP_SSID="${AP_SSID:-PrimeTime Trivia}"
AP_PASS="${AP_PASS:-triviaplayer}"
# A fixed subnet means the join address never changes, so a printed QR code on
# the table cards keeps working forever.
AP_ADDR="${AP_ADDR:-192.168.50.1/24}"
# 'bg' is 2.4GHz: slower but longer range and works with older tablets, which
# matters more than throughput here — the game sends a few KB per question.
AP_BAND="${AP_BAND:-bg}"

IFACE="$(nmcli -t -f DEVICE,TYPE device | awk -F: '$2=="wifi"{print $1; exit}')"
[ -n "$IFACE" ] || { echo "No wifi interface found."; exit 1; }

status() {
  echo "  interface   $IFACE"
  echo "  active      $(nmcli -t -f NAME,DEVICE con show --active | awk -F: -v i="$IFACE" '$2==i{print $1}' || echo none)"
  echo "  address     $(ip -4 -o addr show "$IFACE" | awk '{print $4}' | head -1)"
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then echo "  internet    yes"; else echo "  internet    no"; fi
}

case "$MODE" in
  status) status; exit 0 ;;
  ap|client) [ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; } ;;
  *) echo "Usage: sudo $0 ap|client|status"; exit 1 ;;
esac

if [ "$MODE" = "ap" ]; then
  if ! nmcli -t -f NAME con show | grep -qx "$AP_CON"; then
    echo "Creating access point profile '$AP_CON'..."
    nmcli con add type wifi ifname "$IFACE" con-name "$AP_CON" autoconnect no ssid "$AP_SSID"
    nmcli con modify "$AP_CON" \
      802-11-wireless.mode ap \
      802-11-wireless.band "$AP_BAND" \
      802-11-wireless.hidden no \
      wifi-sec.key-mgmt wpa-psk \
      wifi-sec.psk "$AP_PASS" \
      ipv4.method shared \
      ipv4.addresses "$AP_ADDR" \
      ipv6.method disabled
  fi
  echo "Switching to access point mode in 3 seconds."
  echo "You will lose this connection if you are on wifi. Reconnect to:"
  echo "    SSID      $AP_SSID"
  echo "    password  $AP_PASS"
  echo "    the box   ${AP_ADDR%/*}"
  # Detached so the switch does not kill the command that is performing it.
  nohup sh -c "sleep 3; nmcli con up '$AP_CON'" >/dev/null 2>&1 &
  exit 0
fi

# client
CLIENT_CON="$(nmcli -t -f NAME,TYPE con show | awk -F: '$2=="802-11-wireless"{print $1}' | grep -vx "$AP_CON" | head -1)"
[ -n "$CLIENT_CON" ] || { echo "No saved wifi connection to return to."; exit 1; }
echo "Rejoining '$CLIENT_CON' in 3 seconds..."
nohup sh -c "sleep 3; nmcli con up '$CLIENT_CON'" >/dev/null 2>&1 &
