#!/usr/bin/env bash
# Installs bobik's shell host on Ubuntu 24.04 x86_64. Safe to run again: each step converges to the same state.
# Needs /etc/bobik/shell.env (root:root, mode 600) with SHELL_TOKEN=<the Worker's SHELL_TOKEN>; this script never writes it.
# Run as root from a copy of shell-host/ that also holds the daemon as ./pi-env (or set PI_ENV_BIN).
set -euo pipefail

BUN_VERSION=1.4.4
here=$(cd "$(dirname "$0")" && pwd)
pi_env=${PI_ENV_BIN:-$here/pi-env}

die() { echo "install.sh: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ -x $pi_env ]] || die "no pi-env daemon at $pi_env (copy node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env)"

secrets=/etc/bobik/shell.env
[[ -f $secrets ]] || die "$secrets is missing; create it (root:root, 600) with SHELL_TOKEN=..."
[[ $(stat -c '%u %a' "$secrets") == "0 600" ]] || die "$secrets must be owned by root with mode 600"
token=$(sed -n 's/^SHELL_TOKEN=//p' "$secrets" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
[[ -n $token ]] || die "$secrets has no SHELL_TOKEN"

# The bridge gets only the token's digest, so a shell that reads its environment cannot reuse it.
digest=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
unset token
(umask 077 && printf 'SHELL_TOKEN_SHA256=%s\n' "$digest" > /etc/bobik/bridge.env.new)
mv /etc/bobik/bridge.env.new /etc/bobik/bridge.env

if ! id bobik >/dev/null 2>&1; then
	useradd --create-home --user-group --shell /bin/bash bobik
fi
for group in sudo admin wheel; do
	gpasswd -d bobik "$group" >/dev/null 2>&1 || true
done
chmod 750 /home/bobik
install -d -o bobik -g bobik -m 750 /home/bobik/threads

if [[ ! -x /opt/bobik/bun/bin/bun || $(/opt/bobik/bun/bin/bun --version) != "$BUN_VERSION" ]]; then
	command -v unzip >/dev/null || { apt-get update -qq && apt-get install -y -qq unzip; }
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64-baseline.zip"
	unzip -q "$tmp/bun.zip" -d "$tmp"
	install -D -m 755 "$tmp/bun-linux-x64-baseline/bun" /opt/bobik/bun/bin/bun
fi
ln -sfn /opt/bobik/bun/bin/bun /usr/local/bin/bun

install -d -m 755 /opt/bobik /opt/bobik/bridge
install -m 755 "$pi_env" /opt/bobik/pi-env
install -m 644 "$here/bridge.ts" "$here/protocol.ts" /opt/bobik/bridge/

install -m 644 "$here/bobik-bridge.service" "$here/bobik-keepalive.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet bobik-bridge.service bobik-keepalive.service
systemctl restart bobik-bridge.service bobik-keepalive.service

for _ in $(seq 1 20); do
	if curl -fsS http://127.0.0.1:8788/healthz; then echo; exit 0; fi
	sleep 0.5
done
die "bridge did not answer on 127.0.0.1:8788; see journalctl -u bobik-bridge"
