#!/bin/sh
# Take a copy of everything that is not already in the code: the accounts database (D1), the list of publications and their
# settings (KV "config"), and the whole git history as one file. Run it from anywhere: cloud/backup.sh
# The copies go in ../backups/ (git-ignored: the database holds email addresses and password hashes, so it must never be committed).
# This protects against a bad deploy or a mistaken delete. It does NOT protect against losing this Mac: for that, the backups
# folder has to be copied somewhere else, and the code pushed to a private repository (see README, "Backups").
set -e
cd "$(dirname "$0")/.."
STAMP=$(date +%Y%m%d-%H%M)
OUT=backups
mkdir -p "$OUT"
npx wrangler d1 export DB --remote --output="$OUT/db-$STAMP.sql" >/dev/null
npx wrangler kv key get config --binding STORE --remote > "$OUT/config-$STAMP.json"
git bundle create "backups/code-$STAMP.bundle" --all >/dev/null 2>&1
ls -lh "$OUT" | grep "$STAMP" | awk '{print $5, $9}'
echo "Backed up to $(cd "$OUT" && pwd). Copy this folder off the Mac to be safe against losing it."
