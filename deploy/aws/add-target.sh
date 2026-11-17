#!/usr/bin/env bash
# Adds one resolver (ISP) to the running instance: writes /etc/browser-test/targets/<label>.env
# and creates its heartbeat alarm. Safe to run twice: an existing target file is not
# overwritten unless FORCE=1.
#
# Usage:  deploy/aws/add-target.sh <label> <resolver-ipv4>
# Env:    FORCE=1 overwrite an existing target file; RUN_NOW=1 start a run afterwards;
#         AWS_PROFILE, AWS_REGION, DRY_RUN=1 (no aws call at all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/common.sh
. "$HERE/common.sh"

[ "$#" -eq 2 ] || die "Usage: deploy/aws/add-target.sh <label> <resolver-ipv4>"
LABEL="$1"; IP="$2"
valid_label "$LABEL" || die "Label '$LABEL' is not valid: use letters, digits, - and _ (max 40)."
valid_ipv4 "$IP" || die "'$IP' is not a valid IPv4 address."

resolve_account
TOPIC_ARN="arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"
require_instance

FILE="/etc/browser-test/targets/${LABEL}.env"
# The command has no quotes that need escaping in JSON. The IP and label were validated above.
if [ "${FORCE:-0}" = "1" ]; then
  CMD="install -d -m 0755 /etc/browser-test/targets && echo RESOLVER_DNS_IP=${IP} > ${FILE} && chmod 0644 ${FILE}"
else
  CMD="install -d -m 0755 /etc/browser-test/targets && if [ -e ${FILE} ]; then echo EXISTS; exit 3; else echo RESOLVER_DNS_IP=${IP} > ${FILE} && chmod 0644 ${FILE}; fi"
fi
if mut "write $FILE on $INSTANCE_ID via SSM (refuses to overwrite unless FORCE=1)"; then
  ssm_run "$CMD" || die "Could not write $FILE. If the file already exists, set FORCE=1 to overwrite, or edit it by hand through a shell."
fi
put_heartbeat_alarm "$LABEL"
if [ "${RUN_NOW:-0}" = "1" ]; then
  if mut "start browser-test.service on $INSTANCE_ID now (runs ALL targets one after another)"; then
    ssm_run "systemctl start --no-block browser-test.service" || warn "Could not start the run. It will start at the next timer tick."
  fi
fi

cat >&2 <<OUT

Target '$LABEL' is configured$(is_dry && echo " (DRY_RUN: nothing was changed)").
  - The ISP must approve the Elastic IP of this instance, or its resolver will not answer.
  - Optional overrides (URLS, BLOCKED_URLS, BLOCK_PAGE_IPS, MAX_BLOCK_FAILED, MAX_P95_DNS_MS, ...):
      aws ssm start-session --target $INSTANCE_ID
      sudo nano $FILE     # add KEY=value lines
  - The next timer run includes this target. Remove it with deploy/aws/remove-target.sh $LABEL
OUT
