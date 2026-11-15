#!/usr/bin/env bash
# Uploads bobik's Worker secrets from the existing sources. Prints names, never values.
# Only the secrets listed in scripts/secrets-json.ts are written; other Worker secrets are left alone.
set -euo pipefail
set +x
umask 077

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bot_dir=${BOT_DIR:-$HOME/hackathon-bot}
verda_file=${VERDA_FILE:-$HOME/.local/state/j26-verda/app-secrets.json}
state_dir=${BOBIK_STATE_DIR:-$HOME/.local/state/bobik-pi-durable}
admin_file="$state_dir/admin-secret"

for tool in fnox openssl bun; do command -v "$tool" >/dev/null || { echo "provision: $tool is required" >&2; exit 1; }; done
[ -f "$bot_dir/fnox.toml" ] || { echo "provision: $bot_dir/fnox.toml not found" >&2; exit 1; }
[ -f "$bot_dir/bot.env" ] || { echo "provision: $bot_dir/bot.env not found" >&2; exit 1; }
[ -f "$verda_file" ] || { echo "provision: $verda_file not found" >&2; exit 1; }

mkdir -p "$state_dir"
if [ ! -s "$admin_file" ]; then
	openssl rand -hex 32 > "$admin_file"
	echo "provision: generated a new admin secret in $admin_file" >&2
else
	echo "provision: reusing the admin secret in $admin_file" >&2
fi

cd "$bot_dir"
fnox exec -- env BOT_ENV="$bot_dir/bot.env" VERDA_FILE="$verda_file" ADMIN_FILE="$admin_file" \
	bun "$repo_dir/scripts/secrets-json.ts" \
	| (cd "$repo_dir" && bunx wrangler secret bulk)
