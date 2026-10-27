#!/usr/bin/env bash
# One-shot push-notification setup, to run AFTER Firebase's terms have been accepted once at
# https://console.firebase.google.com (signed in as the Google account the firebase/gcloud CLIs use).
#   scripts/setup-firebase.sh [gcp-project-id]
# It: adds Firebase to the project, registers the Android app, writes mobile/android/app/google-services.json,
# creates a server-side service-account key, hands it to Railway as FIREBASE_SERVICE_ACCOUNT_B64 (never to disk
# for longer than this script runs), and redeploys the backend so push turns on.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${1:-train-watcher-c28c2}"
PACKAGE="com.afridi.train_watcher"

echo "==> Firebase project $PROJECT"
PROJECTS="$(firebase projects:list 2>/dev/null || true)"   # captured first: grep -q under pipefail can SIGPIPE the CLI
if [[ "$PROJECTS" == *"$PROJECT"* ]]; then
  echo "    already a Firebase project"
else
  # A 403 here means the Firebase terms are not accepted yet for this Google account.
  firebase projects:addfirebase "$PROJECT"
fi
gcloud services enable fcm.googleapis.com --project "$PROJECT"

echo "==> Android app"
APP_ID=$(firebase apps:list ANDROID --project "$PROJECT" --json | node -e '
  const r=JSON.parse(require("fs").readFileSync(0));
  const a=((r.result)||[]).find(x=>x.packageName==="'"$PACKAGE"'");
  process.stdout.write(a?a.appId:"");')
if [ -z "$APP_ID" ]; then
  APP_ID=$(firebase apps:create ANDROID "Train Watcher" --package-name "$PACKAGE" --project "$PROJECT" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.appId')
fi
echo "    app id: $APP_ID"
firebase apps:sdkconfig ANDROID "$APP_ID" --project "$PROJECT" --out mobile/android/app/google-services.json

echo "==> Service account for the backend (FCM HTTP v1)"
SA=$(gcloud iam service-accounts list --project "$PROJECT" --filter="email~firebase-adminsdk" --format="value(email)" | head -1)
[ -n "$SA" ] || { echo "No firebase-adminsdk service account found yet; wait a minute and re-run." >&2; exit 1; }
KEY="$(mktemp)"; trap 'shred -u "$KEY" 2>/dev/null || rm -f "$KEY"' EXIT
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project "$PROJECT"
base64 -w0 "$KEY" | (cd backend && railway variable set FIREBASE_SERVICE_ACCOUNT_B64 --stdin -s backend)

echo "==> Done. Rebuild and reinstall the app so it picks up google-services.json:"
echo "    cd mobile && flutter build apk --release && adb install -r build/app/outputs/flutter-apk/app-release.apk"
