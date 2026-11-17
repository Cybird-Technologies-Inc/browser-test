#!/usr/bin/env bash
# Removes one resolver (ISP) from the running instance: deletes its target file and its
# heartbeat alarm. Results already in S3 are kept. Safe to run twice.
#
# Usage:  deploy/aws/remove-target.sh <label>
# Env:    YES=1 skips the typed confirmation; AWS_PROFILE, AWS_REGION, DRY_RUN=1
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/common.sh
. "$HERE/common.sh"

[ "$#" -eq 1 ] || die "Usage: deploy/aws/remove-target.sh <label>"
LABEL="$1"
valid_label "$LABEL" || die "Label '$LABEL' is not valid: use letters, digits, - and _ (max 40)."

resolve_account
require_instance
FILE="/etc/browser-test/targets/${LABEL}.env"

if ! is_dry && [ "${YES:-0}" != "1" ]; then
  warn "This deletes $FILE on $INSTANCE_ID and the alarm ${ALARM_PREFIX}${LABEL}. S3 results are kept."
  [ -t 0 ] || die "No terminal for the confirmation. Re-run in a terminal, or set YES=1."
  printf 'Type "remove %s" to continue: ' "$LABEL" >&2
  read -r reply
  [ "$reply" = "remove $LABEL" ] || die "Confirmation text did not match. Nothing was removed."
fi

if mut "delete $FILE on $INSTANCE_ID via SSM"; then
  ssm_run "rm -f ${FILE}" || die "Could not remove $FILE. Open a shell and delete it by hand."
fi
if mut "delete alarm ${ALARM_PREFIX}${LABEL}"; then
  aws cloudwatch delete-alarms --alarm-names "${ALARM_PREFIX}${LABEL}"
fi
info "Target '$LABEL' removed. Its S3 data under results/resolver=$LABEL/ is kept."
