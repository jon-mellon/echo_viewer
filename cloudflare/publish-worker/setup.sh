#!/usr/bin/env bash
# One-time setup of the publishing worker on your Cloudflare account. Run from this folder after `npx wrangler login`
# (or with CLOUDFLARE_API_TOKEN set). Safe to rerun: each step skips what already exists. Prints no secret.
#
#   ./setup.sh            create the D1 database, apply the migration, set OWNER_SECRET, ask for TURNSTILE_SECRET, deploy
#   ./setup.sh registry   load the existing Supabase registry (31 publications and their splits) into D1
set -euo pipefail
cd "$(dirname "$0")"
WR="npx --yes wrangler"
DB=echo-registry

$WR whoami >/dev/null 2>&1 || { echo "Not logged in to Cloudflare: run 'npx wrangler login' first."; exit 1; }

if [ "${1:-}" = "registry" ]; then
  node scripts/export_registry_sql.mjs > /tmp/echo-registry.sql
  $WR d1 execute "$DB" --remote --file /tmp/echo-registry.sql
  rm -f /tmp/echo-registry.sql
  echo "Registry loaded."
  exit 0
fi

# 1. The registry database, and its id in wrangler.toml.
if grep -q '^database_id = ""' wrangler.toml; then
  $WR d1 create "$DB" || true
  ID=$($WR d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name==="'"$DB"'");if(!r)process.exit(1);console.log(r.uuid)})')
  sed -i.bak "s#^database_id = \"\"#database_id = \"$ID\"#" wrangler.toml && rm -f wrangler.toml.bak
  echo "Database $DB ready."
fi
$WR d1 migrations apply "$DB" --remote

# 2. Secrets. OWNER_SECRET is generated here and goes straight to Cloudflare; TURNSTILE_SECRET is read without echo.
if ! $WR secret list 2>/dev/null | grep -q OWNER_SECRET; then
  openssl rand -hex 32 | $WR secret put OWNER_SECRET >/dev/null
  echo "OWNER_SECRET set."
fi
if $WR secret list 2>/dev/null | grep -q TURNSTILE_SECRET; then
  :
elif [ ! -t 0 ]; then
  echo "TURNSTILE_SECRET is not set yet (no terminal to ask in). Set it later with: npx wrangler secret put TURNSTILE_SECRET"
else
  echo "Create a Turnstile widget (dashboard > Turnstile > Add widget; hostnames: echo.epistemicinfra.org, www.jonathanmellon.com, jonathanmellon.com)."
  echo "Keep the SITE key for the viewer; paste the SECRET key here (nothing is shown as you type):"
  read -rs TURNSTILE_SECRET
  printf '%s' "$TURNSTILE_SECRET" | $WR secret put TURNSTILE_SECRET >/dev/null
  echo "TURNSTILE_SECRET set."
fi

# 3. Deploy. The custom domain is added in the dashboard (Workers & Pages > echo-publish > Settings > Domains & Routes).
$WR deploy
echo "Deployed. Next: add the custom domain, then run './setup.sh registry'."
