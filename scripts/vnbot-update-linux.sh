#!/usr/bin/env bash
# Installs or updates the VNBot desktop app on Debian or Ubuntu from the published Linux feed.
#   curl -fsSL https://dl.vnbot.run/install/vnbot-linux.sh | sudo bash
# The package is checked against the feed's SHA-512 before apt installs it. A machine that runs
# VNBot as the `vnbot` systemd service, such as a headless server, gets that service restarted.
set -euo pipefail

FEED_BASE="${VNBOT_FEED_BASE:-https://dl.vnbot.run/desktop}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root, for example: curl -fsSL https://dl.vnbot.run/install/vnbot-linux.sh | sudo bash" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian and Ubuntu (apt)." >&2
  exit 1
fi
if [ "$(dpkg --print-architecture)" != "amd64" ]; then
  echo "VNBot for Linux is published for amd64 only." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A fresh query string skips a cached copy of the feed.
curl -fsSL "${FEED_BASE}/latest-linux.yml?t=$(date +%s)" -o "$work/latest-linux.yml"
version="$(sed -n 's/^version: *//p' "$work/latest-linux.yml" | head -1)"
# The .deb entry: its url line, then its sha512 line.
deb="$(sed -n 's/^ *- url: *\(.*\.deb\) *$/\1/p' "$work/latest-linux.yml" | head -1)"
sha512="$(awk -v deb="$deb" '$0 ~ "url: *"deb"$" {found=1; next} found && /sha512:/ {print $2; exit}' "$work/latest-linux.yml")"
if [ -z "$version" ] || [ -z "$deb" ] || [ -z "$sha512" ]; then
  echo "The update feed has no Linux package." >&2
  exit 1
fi
case "$deb" in
  */* | *..*) echo "The update feed names an unexpected package." >&2; exit 1 ;;
esac

installed="$(dpkg-query -W -f='${Version}' vnbot 2>/dev/null || true)"
if [ "$installed" = "$version" ] && [ "${VNBOT_FORCE:-}" != "1" ]; then
  echo "VNBot ${version} is already installed."
  exit 0
fi

echo "Downloading VNBot ${version}..."
curl -fL --retry 3 "${FEED_BASE}/${deb}?v=${version}" -o "$work/$deb"
actual="$(openssl dgst -sha512 -binary "$work/$deb" | base64 -w0)"
if [ "$actual" != "$sha512" ]; then
  echo "The download does not match the published checksum. Nothing was installed." >&2
  exit 1
fi

echo "Installing VNBot ${version}..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq "$work/$deb" >/dev/null

if systemctl list-unit-files vnbot.service >/dev/null 2>&1 && systemctl is-enabled vnbot.service >/dev/null 2>&1; then
  systemctl restart vnbot.service
  echo "Restarted the vnbot service."
fi
echo "VNBot $(dpkg-query -W -f='${Version}' vnbot) is installed."
