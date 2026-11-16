#!/usr/bin/env bash
# Installs bobik's shell host on Ubuntu 24.04 x86_64: the shell bridge, bobik's memory server and Caddy in front of both.
# Safe to run again: each step converges to the same state.
# Needs /etc/bobik/shell.env (root:root, mode 600) with SHELL_TOKEN=<the Worker's SHELL_TOKEN>; this script never writes it.
# Needs Caddy, and the Rust Basic Memory port (basic-memory-rs, semantic build) installed for bobik as /home/bobik/.local/bin/bm-rs.
# Run as root from a copy of shell-host/ that also holds the daemon as ./pi-env (or set PI_ENV_BIN).
set -euo pipefail

BUN_VERSION=1.4.4
here=$(cd "$(dirname "$0")" && pwd)
pi_env=${PI_ENV_BIN:-$here/pi-env}

die() { echo "install.sh: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ -x $pi_env ]] || die "no pi-env daemon at $pi_env (copy node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env)"
bm=/home/bobik/.local/bin/bm-rs
[[ -x $bm ]] || die "no Basic Memory at $bm; build basic-memory-rs with --features semantic on Ubuntu 24.04, install it there, then as bobik: bm-rs project add bobik /home/bobik/memory"
command -v caddy >/dev/null || die "Caddy is not installed"
site=$(awk '/^[^{}#[:space:]]/ { print $1; exit }' "$here/Caddyfile")

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

install -m 644 "$here/bobik-bridge.service" "$here/bobik-keepalive.service" "$here/bobik-memory.service" /etc/systemd/system/
# The Caddyfile turns the admin API off, so Caddy cannot reload and every change is a restart.
install -d -m 755 /etc/systemd/system/caddy.service.d
install -m 644 "$here/caddy-bobik.conf" /etc/systemd/system/caddy.service.d/bobik.conf
caddy validate --adapter caddyfile --config "$here/Caddyfile" >/dev/null 2>&1 || die "Caddyfile does not validate"
install -m 644 "$here/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --quiet bobik-bridge.service bobik-keepalive.service bobik-memory.service
systemctl restart bobik-bridge.service bobik-keepalive.service bobik-memory.service
systemctl restart caddy

# The memory server takes about 40 s to start on the 1/8-OCPU micro shape.
wait_for() {
	local what=$1; shift
	for _ in $(seq 1 240); do
		if "$@"; then return 0; fi
		sleep 0.5
	done
	die "$what did not come up"
}
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh","version":"1"}}}'
wait_for "bridge on 127.0.0.1:8788 (journalctl -u bobik-bridge)" curl -fs -o /dev/null http://127.0.0.1:8788/healthz
wait_for "memory server on 127.0.0.1:8800 (journalctl -u bobik-memory)" curl -fs -o /dev/null -X POST http://127.0.0.1:8800/mcp \
	-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$initialize"
status=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$site:443:127.0.0.1" -X POST "https://$site/mcp")
[[ $status == 401 ]] || die "https://$site/mcp without a token answered $status, not 401"
echo "bridge, memory server and Caddy are up; /mcp refuses requests without the token"
