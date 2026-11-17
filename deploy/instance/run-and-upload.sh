#!/usr/bin/env bash
# One monitoring run: npm start, then ALWAYS upload the results, then send the heartbeat.
# Started by browser-test.service (as user browsertest, env from /etc/browser-test/env).
# Exit code = the npm exit code (0 ok, 1 threshold exceeded, 2 config error).
set -euo pipefail

log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$1" "${*:2}" >&2; }

CONF_DIR=/etc/browser-test
APP=/opt/browser-test/current
OUT_DIR="${OUT_DIR:-/var/lib/browser-test/out}"
LABEL="${RESOLVER_LABEL:-unlabeled}"
BUCKET="$(cat "$CONF_DIR/bucket")"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$(cat "$CONF_DIR/region")}"

# Runs must never overlap: a slow run would otherwise load the resolver twice.
exec 9>"${LOCK_FILE:-/var/lib/browser-test/run.lock}"
flock -n 9 || { log WARN "Previous run still active, skipping this one."; exit 0; }

# Old files would be uploaded as if they were new if this run crashed before writing.
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/page-summary.csv" "$OUT_DIR/request-details.csv" "$OUT_DIR/summary.json"

STARTED="$(date -u +%Y-%m-%d/%H%M%SZ)"
PREFIX="s3://$BUCKET/results/resolver=$LABEL/date=${STARTED%/*}/${STARTED#*/}"

rc=0
(cd "$APP" && npm start) || rc=$?
log INFO "npm start exited with $rc"

# Upload on every exit code: a failed run is exactly when the data matters.
# A missing file (crash, exit 2) is skipped and logged, not fatal.
for f in page-summary.csv request-details.csv summary.json; do
  if [ -f "$OUT_DIR/$f" ]; then
    aws s3 cp "$OUT_DIR/$f" "$PREFIX/$f" --only-show-errors || log ERROR "Upload of $f failed. Check the instance role and DNS to AWS."
  else
    log WARN "$f was not produced"
  fi
done
if [ -f "$OUT_DIR/summary.json" ]; then
  aws s3 cp "$OUT_DIR/summary.json" "s3://$BUCKET/results/resolver=$LABEL/latest.json" --only-show-errors \
    || log ERROR "Upload of latest.json failed."
fi
# Remember where this run's files went, for alert.sh.
printf '%s\n' "${PREFIX#s3://$BUCKET/}" >"$OUT_DIR/last-results-key" || true

# Heartbeat: only for runs that finished (0 or 1). Exit 2 or a crash sends nothing,
# so the CloudWatch alarm fires when the timer is dead OR the runner is broken.
if [ "$rc" = "0" ] || [ "$rc" = "1" ]; then
  aws cloudwatch put-metric-data --namespace BrowserTest --metric-name RunCompleted \
    --dimensions "Resolver=$LABEL" --value 1 --unit Count \
    || log ERROR "Heartbeat metric failed. The heartbeat alarm may fire."
fi
exit "$rc"
