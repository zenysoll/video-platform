#!/usr/bin/env bash
# deploy.sh — build and deploy to Cloudflare Workers via raw CF API.
#
# Workaround: wrangler v4 /versions endpoint is blocked by Cloudflare bot
# protection from this IP. We use the older PUT API + PATCH env settings.
#
# Usage: ./deploy.sh

set -euo pipefail

ACCOUNT_ID="a73c7186fc1af802c26df5841a4c941d"
SCRIPT_NAME="video-platform"
OAUTH_TOKEN=$(grep 'oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
DIST="/tmp/worker-dist"

# ── 1. Build ──────────────────────────────────────────────────────────────────
echo "Building bundle..."
# Always start clean to prevent stale hashed module files from previous builds
# causing "No such module" errors when index.js references a new hash.
rm -rf "$DIST"
pnpm exec wrangler deploy --dry-run --outdir "$DIST" 2>&1 | grep -E "Total Upload|dry-run"

INDEX_JS="$DIST/index.js"

METADATA='{"main_module":"index.js","compatibility_date":"2024-09-23","compatibility_flags":["nodejs_compat"]}'

# ── 2. Upload script ──────────────────────────────────────────────────────────
echo "Uploading script..."

# Build curl args array to avoid quoting issues.
# Dynamically include ALL hashed text modules (.sh, .py) from the dist dir.
CURL_ARGS=(
  -s -X PUT
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}"
  -H "Authorization: Bearer ${OAUTH_TOKEN}"
  -F "metadata=${METADATA};type=application/json"
  -F "index.js=@${INDEX_JS};type=application/javascript+module"
)

# Add every .sh and .py file — CF requires text/plain for text modules
for f in "$DIST"/*.sh "$DIST"/*.py; do
  [ -f "$f" ] || continue
  bn=$(basename "$f")
  CURL_ARGS+=(-F "${bn}=@${f};type=text/plain")
  echo "  + module: $bn"
done

RESULT=$(curl "${CURL_ARGS[@]}")

if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d['success'] else 1)" 2>/dev/null; then
  MODIFIED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['modified_on'])")
  echo "Script uploaded OK (modified: ${MODIFIED})"
else
  echo "Upload FAILED:"
  echo "$RESULT" | python3 -m json.tool
  exit 1
fi

# ── 3. Patch environment ──────────────────────────────────────────────────────
echo "Patching environment settings..."

# Write settings to a temp file to avoid quoting issues with heredoc.
SETTINGS_FILE=$(mktemp /tmp/cf-settings-XXXXXX.json)
cat > "$SETTINGS_FILE" <<'ENDJSON'
{
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "bindings": [
    {"type": "plain_text", "name": "ENVIRONMENT",                "text": "production"},
    {"type": "plain_text", "name": "LOG_LEVEL",                  "text": "info"},
    {"type": "plain_text", "name": "CONTROL_BOT_WEBHOOK_PATH",   "text": "/webhook/control"},
    {"type": "plain_text", "name": "PUBLISHER_BOT_WEBHOOK_PATH", "text": "/webhook/publisher"},
    {"type": "plain_text", "name": "VAST_API_BASE_URL",          "text": "https://console.vast.ai/api/v0"},
    {"type": "plain_text", "name": "GEMINI_MODEL",               "text": "gemini-2.0-flash"},
    {"type": "plain_text", "name": "PROMPT_BATCH_SIZE",          "text": "20"},
    {"type": "plain_text", "name": "DIVERSITY_MODE",             "text": "soft"},
    {"type": "d1",         "name": "DB",                         "id": "5c9b7b90-c530-46dd-8c0b-2414c10e845a"},
    {"type": "r2_bucket",  "name": "R2_ADMIN",                   "bucket_name": "video-platform-admin"},
    {"type": "queue",      "name": "RENDER_QUEUE",               "queue_name": "render-queue"},
    {"type": "queue",      "name": "PUBLISH_QUEUE",              "queue_name": "publish-queue"},
    {"type": "queue",      "name": "STREAM_QUEUE",               "queue_name": "stream-queue"},
    {"type": "secret_text","name": "ACCESS_PASSWORD_HASH"},
    {"type": "secret_text","name": "CONTROL_BOT_TOKEN"},
    {"type": "secret_text","name": "CONTROL_BOT_SECRET"},
    {"type": "secret_text","name": "PUBLISHER_BOT_TOKEN"},
    {"type": "secret_text","name": "PUBLISHER_BOT_SECRET"},
    {"type": "secret_text","name": "VAST_API_KEY"},
    {"type": "secret_text","name": "R2_ACCOUNT_TOKEN"},
    {"type": "secret_text","name": "R2_ACCOUNT_ID"},
    {"type": "secret_text","name": "TELEGRAM_CHANNEL_ID"},
    {"type": "secret_text","name": "GEMINI_API_KEY"},
    {"type": "secret_text","name": "WORKER_SECRET"},
    {"type": "secret_text","name": "HF_TOKEN"},
    {"type": "secret_text","name": "R2_MODEL_KEY_ID"},
    {"type": "secret_text","name": "R2_MODEL_SECRET"}
  ]
}
ENDJSON

PATCH_RESULT=$(curl -s -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/services/${SCRIPT_NAME}/environments/production/settings" \
  -H "Authorization: Bearer ${OAUTH_TOKEN}" \
  -F "settings=@${SETTINGS_FILE};type=application/json")

rm -f "$SETTINGS_FILE"

if echo "$PATCH_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d['success'] else 1)" 2>/dev/null; then
  COUNT=$(echo "$PATCH_RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['bindings']))")
  echo "Environment patched — ${COUNT} bindings set"
else
  echo "PATCH FAILED:"
  echo "$PATCH_RESULT" | python3 -m json.tool
  exit 1
fi

# ── 4. Verify ─────────────────────────────────────────────────────────────────
echo ""
sleep 2
STATUS=$(curl -sf "https://video-platform.zenyzeland.workers.dev/health" 2>/dev/null || echo '{"status":"error"}')
echo "Health: $STATUS"
echo "Deploy complete."
