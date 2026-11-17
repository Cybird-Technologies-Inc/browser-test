#!/usr/bin/env bash
# Runs as root on the instance, from the unpacked release: /opt/browser-test/<sha>/deploy/instance/setup.sh
# Called by user-data on first boot and by deploy/aws/update.sh on every update.
# Idempotent: each step checks its result first, so a second run changes nothing.
#
# Operator edits survive: /etc/browser-test/env is written ONLY if it does not exist.
# To change the profile or thresholds, edit that file (see deploy/README.md).
set -euo pipefail

log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$1" "${*:2}" >&2; }
die() { log ERROR "$@"; exit 1; }

[ "$(id -u)" = "0" ] || die "setup.sh must run as root. Run it with sudo."
export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive

# Pinned Node 22 LTS. Bump on purpose, together with a test run; never use "latest".
NODE_VERSION="${NODE_VERSION:-v22.23.5}"
NODE_ROOT=/opt/node
APP_ROOT=/opt/browser-test
CONF_DIR=/etc/browser-test
STATE_DIR=/var/lib/browser-test
RUN_USER=browsertest
export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/pw-browsers"

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$RELEASE_DIR" in
  "$APP_ROOT"/*) ;;
  *) die "Release must be unpacked under $APP_ROOT (found $RELEASE_DIR). Use deploy/aws/update.sh." ;;
esac
[ -d "$CONF_DIR" ] || die "$CONF_DIR is missing. It is created by user-data; re-run deploy/aws/install.sh."

# Atomic symlink switch: create the new link beside the old one, then rename over it.
flip_link() { ln -sfn "$1" "$2.tmp" && mv -Tf "$2.tmp" "$2"; }

# --- 1. OS tools ---
# awscli v2 is installed by user-data from the official zip (Ubuntu 24.04 has no apt awscli,
# and the snap is avoided). Only plain tools are needed here.
log INFO "Installing OS packages"
apt-get update -y
apt-get install -y ca-certificates curl xz-utils util-linux jq

# --- 2. Node from a pinned tarball, checksum verified ---
NODE_DIR="$NODE_ROOT/node-$NODE_VERSION-linux-x64"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  log INFO "Installing Node $NODE_VERSION"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  base="https://nodejs.org/dist/$NODE_VERSION"
  file="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "$base/$file" -o "$work/$file"
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  # Only the line for our file is checked. A mismatch aborts the setup.
  # This guards against a corrupt or swapped download; it does not replace verifying the
  # release signature (SHASUMS256.txt.sig) if the threat model needs it.
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch for $file. Nothing was installed. Retry; if it repeats, stop and investigate."
  mkdir -p "$NODE_ROOT"
  tar -xJf "$work/$file" -C "$NODE_ROOT"
fi
flip_link "$NODE_DIR" "$NODE_ROOT/current"
for b in node npm npx; do flip_link "$NODE_ROOT/current/bin/$b" "/usr/local/bin/$b"; done
export PATH="/usr/local/bin:$PATH"

# --- 3. Service user ---
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log INFO "Creating user $RUN_USER"
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$STATE_DIR" "$STATE_DIR/out"

# --- 4. App: dependencies, browser, current link ---
log INFO "Installing app dependencies in $RELEASE_DIR"
(cd "$RELEASE_DIR" && npm ci --no-audit --no-fund)
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
(cd "$RELEASE_DIR" && npx playwright install --with-deps chromium)
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" "$RELEASE_DIR"
chmod 0755 "$RELEASE_DIR"/deploy/instance/*.sh
flip_link "$RELEASE_DIR" "$APP_ROOT/current"

# Ubuntu 24.04 blocks the unprivileged user namespaces that Chromium's sandbox needs.
# Allow them for the Playwright browser binaries ONLY, as Ubuntu itself does for Chrome,
# instead of lifting the restriction for the whole host or running with --no-sandbox
# (pages are untrusted web content, so the sandbox stays on).
if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then
  cat >/etc/apparmor.d/browser-test-chromium <<PROFILE
# Managed by deploy/instance/setup.sh
abi <abi/4.0>,
include <tunables/global>
profile browser-test-chromium $PLAYWRIGHT_BROWSERS_PATH/**/{chrome,headless_shell,chrome-headless-shell} flags=(unconfined) {
  userns,
}
PROFILE
  apparmor_parser -r /etc/apparmor.d/browser-test-chromium \
    || log WARN "Loading the AppArmor profile failed; Chromium may report 'No usable sandbox'. Check 'journalctl -k | grep apparmor'."
else
  log WARN "AppArmor tools not found; Chromium may report 'No usable sandbox'."
fi

# --- 5. Env file: created once, never overwritten ---
if [ ! -f "$CONF_DIR/env" ]; then
  log INFO "Writing $CONF_DIR/env from profiles/light.env (first install only)"
  {
    cat "$RELEASE_DIR/profiles/light.env"
    echo "RESOLVER_LABEL=leohat"
    echo "OUT_DIR=$STATE_DIR/out"
    echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"
    # Feed-category check: off until the operator fills the list and the sinkhole IP.
    echo "# BLOCKED_URLS=$CONF_DIR/blocked.txt"
    echo "# BLOCK_PAGE_IPS=<LeoHat sinkhole IPv4,IPv6>"
    echo "# MAX_BLOCK_FAILED=0"
  } >"$CONF_DIR/env"
  chmod 0644 "$CONF_DIR/env"
else
  log INFO "$CONF_DIR/env exists, left unchanged"
fi

# Template for the feed-category list; never overwrites the operator's copy.
[ -f "$CONF_DIR/blocked.txt" ] || install -m 0644 "$RELEASE_DIR/profiles/blocked.example.txt" "$CONF_DIR/blocked.txt"

# --- 6. systemd units ---
for u in browser-test.service browser-test.timer browser-test-alert.service; do
  install -m 0644 "$RELEASE_DIR/deploy/instance/systemd/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable --now browser-test.timer

# --- 7. DNS, LAST ---
# Last on purpose: apt, npm and the Node download above need a working resolver.
# From here on the host resolves through LeoHat, so a failure leaves the box on its old DNS.
[ -s "$CONF_DIR/leohat-dns" ] || die "$CONF_DIR/leohat-dns is missing or empty. DNS was not changed."
LEOHAT_DNS_IP="$(tr -d '[:space:]' <"$CONF_DIR/leohat-dns")"
printf '%s' "$LEOHAT_DNS_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || die "$CONF_DIR/leohat-dns does not hold an IPv4 address. DNS was not changed."
systemctl is-active --quiet systemd-resolved || die "systemd-resolved is not running; this script only supports it. DNS was not changed."

install -d -m 0755 /etc/systemd/resolved.conf.d
# FallbackDNS is EMPTY on purpose: a silent fallback to a public resolver would hide a
# LeoHat outage and produce good-looking results that do not measure LeoHat.
cat >/etc/systemd/resolved.conf.d/browser-test.conf <<CONF
# Managed by deploy/instance/setup.sh. All names go to LeoHat, with no fallback.
[Resolve]
DNS=$LEOHAT_DNS_IP
Domains=~.
FallbackDNS=
CONF

# AWS endpoints bypass LeoHat so uploads and alerts still work when LeoHat is down.
# The longest matching routing domain wins, so ~amazonaws.com beats the global ~. .
# default-route=no keeps the VPC resolver from also answering everything else.
VPC_DNS=169.254.169.253
IFACE="$(ip -o route show default | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')"
[ -n "$IFACE" ] || die "No default network interface found. DNS for AWS endpoints was not set; check 'ip route'."
NETFILE="$(networkctl status "$IFACE" --no-pager 2>/dev/null | sed -n 's/^ *Network File: *//p' | head -n1)"
if [ -n "$NETFILE" ]; then
  # Persistent: a networkd drop-in survives reboots and DHCP renewals.
  d="/etc/systemd/network/$(basename "$NETFILE").d"
  install -d -m 0755 "$d"
  cat >"$d/browser-test.conf" <<CONF
# Managed by deploy/instance/setup.sh. Send only AWS names to the VPC resolver.
[Network]
DNS=$VPC_DNS
Domains=~amazonaws.com
DNSDefaultRoute=no
[DHCPv4]
UseDNS=no
UseDomains=no
CONF
  networkctl reload
  networkctl reconfigure "$IFACE" || log WARN "networkctl reconfigure $IFACE failed; falling back to the runtime setting below."
else
  log WARN "No networkd file found for $IFACE; using a runtime-only setting that does not survive a reboot."
fi
# Runtime setting too, so it works now even if the reconfigure has not finished.
resolvectl dns "$IFACE" "$VPC_DNS"
resolvectl domain "$IFACE" '~amazonaws.com'
resolvectl default-route "$IFACE" no
systemctl restart systemd-resolved

if getent hosts "s3.${AWS_DEFAULT_REGION:-$(cat "$CONF_DIR/region" 2>/dev/null || echo ap-south-1)}.amazonaws.com" >/dev/null; then
  log INFO "AWS endpoints resolve through the VPC resolver"
else
  log WARN "AWS endpoint did not resolve after the DNS change. Uploads and alerts will fail until fixed: check 'resolvectl status'."
fi
getent hosts example.com >/dev/null \
  && log INFO "LeoHat resolves example.com" \
  || log WARN "LeoHat did not answer example.com. Is this host's Elastic IP in the LeoHat approved networks? Runs will fail until it is."
log INFO "Setup finished for release $(basename "$RELEASE_DIR")"
