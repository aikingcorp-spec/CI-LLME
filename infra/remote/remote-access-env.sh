#!/bin/sh
# Builds the central process environment from the separate staging secret.
# The secret file is never printed. A token that can see vnbot.run is refused.
set -eu
umask 077

if [ "${1:-}" != "check" ] && [ "${1:-}" != "install" ] && [ "${1:-}" != "rotate" ]; then
  echo "usage: remote-access-env.sh check|install|rotate" >&2
  exit 1
fi

STAGING=${REMOTE_STAGING_FILE:-/etc/vnbot-040/remote-staging.env}
CENTRAL=${REMOTE_CENTRAL_FILE:-/etc/vnbot-040/central-remote.env}
API=${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}

if [ ! -f "$STAGING" ]; then
  echo "Remote staging file is missing" >&2
  exit 1
fi
perm=$(stat -c %a "$STAGING")
if [ "$((perm % 100))" -ne 0 ]; then
  echo "Remote staging file must not be readable by the group or others" >&2
  exit 1
fi

CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_API_TOKEN=
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "" | \#*) continue ;;
    CLOUDFLARE_ACCOUNT_ID=*) CLOUDFLARE_ACCOUNT_ID=${line#CLOUDFLARE_ACCOUNT_ID=} ;;
    CLOUDFLARE_ZONE_ID=*) CLOUDFLARE_ZONE_ID=${line#CLOUDFLARE_ZONE_ID=} ;;
    CLOUDFLARE_API_TOKEN=*) CLOUDFLARE_API_TOKEN=${line#CLOUDFLARE_API_TOKEN=} ;;
    *)
      echo "Remote staging file has an unexpected line" >&2
      exit 1
      ;;
  esac
done < "$STAGING"

strip() {
  value=$1
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}
CLOUDFLARE_ACCOUNT_ID=$(strip "$CLOUDFLARE_ACCOUNT_ID")
CLOUDFLARE_ZONE_ID=$(strip "$CLOUDFLARE_ZONE_ID")
CLOUDFLARE_API_TOKEN=$(strip "$CLOUDFLARE_API_TOKEN")

printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | grep -Eq '^[0-9a-fA-F]{32}$' || {
  echo "Remote staging account id is invalid" >&2
  exit 1
}
printf '%s' "$CLOUDFLARE_ZONE_ID" | grep -Eq '^[0-9a-fA-F]{32}$' || {
  echo "Remote staging zone id is invalid" >&2
  exit 1
}
printf '%s' "$CLOUDFLARE_API_TOKEN" | grep -Eq '^[^[:space:]]{20,4096}$' || {
  echo "Remote staging token is invalid" >&2
  exit 1
}
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN

body=$(
  curl --silent --show-error --fail --max-time 20 --config - \
    --url "${API}/zones?per_page=50" <<EOF
header = "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
EOF
)
zones=$(printf '%s' "$body" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const body = JSON.parse(raw);
  const rows = body && body.result;
  const pages = body && body.result_info && body.result_info.total_pages;
  if (!Array.isArray(rows) || (pages && pages > 1)) process.exit(2);
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") process.exit(2);
    process.stdout.write(row.id + "\t" + row.name + "\n");
  }
});
') || {
  echo "BLOCKED: the zone list did not prove this token is isolated" >&2
  exit 2
}
if printf '%s\n' "$zones" | grep -q '	vnbot.run$'; then
  echo "BLOCKED: this token can see the production zone" >&2
  exit 2
fi
suffix=$(printf '%s\n' "$zones" | awk -F '\t' -v id="$CLOUDFLARE_ZONE_ID" '$1 == id { print $2 }')
if [ -z "$suffix" ]; then
  echo "BLOCKED: the configured zone is not visible to this token" >&2
  exit 2
fi
echo "Remote zone: $suffix"
if [ "$1" = "check" ]; then
  unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN
  exit 0
fi

directory=$(dirname "$CENTRAL")
mkdir -p "$directory"
chmod 700 "$directory"
temporary=$(mktemp "${CENTRAL}.XXXXXX")
chmod 600 "$temporary"
REMOTE_NAME=$suffix node -e '
const fs = require("node:fs");
const payload = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  zoneId: process.env.CLOUDFLARE_ZONE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  nameSuffix: process.env.REMOTE_NAME,
};
const file = process.argv[1];
fs.writeFileSync(file, "RAKAZO_REMOTE_ACCESS=" + JSON.stringify(payload) + "\nRAKAZO_REMOTE_NAME_SUFFIX=" + payload.nameSuffix + "\n", { mode: 0o600 });
' "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$CENTRAL"
chmod 600 "$CENTRAL"
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN
echo "Wrote the central process file. Restart that process to load it."
