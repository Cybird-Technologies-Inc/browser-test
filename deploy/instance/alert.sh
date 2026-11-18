#!/usr/bin/env bash
# Publishes a short plain-text alert to SNS. No secrets: host, time, label, exit code,
# violation lines and the S3 key only.
#
# Two modes:
#   alert.sh <label> <rc> <s3-key>   one target run ended badly (called by run-all.sh)
#   alert.sh                         the runner itself failed (OnFailure= of browser-test.service)
set -euo pipefail

CONF_DIR="${CONF_DIR:-/etc/browser-test}"
OUT_DIR="${OUT_DIR:-/var/lib/browser-test/out}"   # base folder; each target uses <OUT_DIR>/<label>
AWS_CMD="${AWS_CMD:-aws}"
TOPIC="$(cat "$CONF_DIR/sns-topic-arn")"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$(cat "$CONF_DIR/region")}"
bucket="$(cat "$CONF_DIR/bucket")"
host="$(hostname)"; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$#" -eq 0 ]; then
  code="$(systemctl show browser-test.service -p ExecMainStatus --value 2>/dev/null || echo unknown)"
  subject="browser-test runner failed (exit $code)"
  msg="$(printf 'Host: %s\nTime: %s\nThe browser-test runner itself failed (exit %s), not one target.\nLook at: journalctl -u browser-test\n' "$host" "$now" "$code")"
else
  [ "$#" -eq 3 ] || { echo "Usage: alert.sh <label> <rc> <s3-key>" >&2; exit 2; }
  label="$1"; code="$2"; key="$3"
  [[ "$label" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || { echo "Invalid label" >&2; exit 2; }
  [[ "$code" =~ ^[0-9]{1,3}$ ]] || { echo "Invalid exit code" >&2; exit 2; }
  case "$code" in
    1) meaning="threshold exceeded" ;;
    2) meaning="config error (check the target file and /etc/browser-test/env)" ;;
    124) meaning="timeout (run exceeded TARGET_TIMEOUT)" ;;
    125) meaning="could not switch the host resolver to this target" ;;
    *) meaning="crash" ;;
  esac
  violations=""
  if [ -f "$OUT_DIR/$label/summary.json" ]; then
    violations="$(node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const v of s.thresholdViolations || []) console.log("- " + v);
      const f = s.failures || {};
      const b = s.blocked || {};
      if ((b.failedChecks || []).length) console.log("  Category check misses (name, category, expected, result):");
      for (const c of b.failedChecks || []) console.log("    " + c.host + " [" + c.category + ", expected " + c.expected + "] " + c.result + (c.detail ? " (" + c.detail + ")" : ""));
      if ((f.failedUrls || []).length) console.log("  Page failures:");
      for (const u of f.failedUrls || []) console.log("    " + u.url + " [" + u.reason + (u.httpStatus ? " HTTP " + u.httpStatus : "") + "]");
      for (const a of f.advice || []) console.log("    why: " + a);
      if (s.trend && s.trend.notes.length) console.log("  trend: " + s.trend.notes.join("; "));
      const d = s.dnsChecks;
      if (d && d.failed) console.log("  dns-only failures: " + d.failedDomains.join(", "));
    ' "$OUT_DIR/$label/summary.json" 2>/dev/null || echo "- (summary.json could not be read)")"
  fi
  subject="browser-test alert: $label exit $code"
  msg="$(printf 'Host: %s\nTime: %s\nResolver: %s\nExit code: %s (%s)\nViolations:\n%s\nResults: s3://%s/%s\nMore: journalctl -u browser-test\n' \
    "$host" "$now" "$label" "$code" "$meaning" "${violations:-- none recorded}" "$bucket" "$key")"
fi

$AWS_CMD sns publish --topic-arn "$TOPIC" --subject "$subject" --message "$msg" >/dev/null
