#!/usr/bin/env bash
# Publishes a short plain-text alert to SNS. Started by browser-test-alert.service
# (OnFailure of browser-test.service). Contains no secrets: only host, time, exit code,
# the threshold violation lines and the S3 key.
set -euo pipefail

CONF_DIR=/etc/browser-test
OUT_DIR="${OUT_DIR:-/var/lib/browser-test/out}"
TOPIC="$(cat "$CONF_DIR/sns-topic-arn")"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$(cat "$CONF_DIR/region")}"

# systemd records the failed unit's exit status here.
code="$(systemctl show browser-test.service -p ExecMainStatus --value 2>/dev/null || echo unknown)"
case "$code" in
  1) meaning="threshold exceeded" ;;
  2) meaning="config error (see journalctl -u browser-test)" ;;
  *) meaning="crash or timeout (see journalctl -u browser-test)" ;;
esac

violations=""
if [ -f "$OUT_DIR/summary.json" ]; then
  violations="$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const v of s.thresholdViolations || []) console.log("- " + v);
  ' "$OUT_DIR/summary.json" 2>/dev/null || echo "- (summary.json could not be read)")"
fi
key="$(cat "$OUT_DIR/last-results-key" 2>/dev/null || echo "none (no upload recorded)")"

msg="$(printf 'Host: %s\nTime: %s\nExit code: %s (%s)\nViolations:\n%s\nResults: s3://%s/%s\n' \
  "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$meaning" \
  "${violations:-- none recorded}" "$(cat "$CONF_DIR/bucket")" "$key")"

aws sns publish --topic-arn "$TOPIC" --subject "browser-test alert: exit $code" --message "$msg" >/dev/null
