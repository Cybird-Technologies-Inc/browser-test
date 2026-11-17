#!/usr/bin/env bash
# Deploys the current commit (HEAD) to the running instance without recreating anything.
# Flow: upload release tarball to S3, then ask SSM to download it and re-run setup.sh.
# setup.sh is idempotent, so running this twice is safe. Operator edits to
# /etc/browser-test/env are kept (setup.sh only creates that file if it is missing).
#
# Optional env: AWS_PROFILE (Cybird-Dev), AWS_REGION (ap-south-1), ALLOW_DIRTY=1, DRY_RUN=1
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/common.sh
. "$HERE/common.sh"

TMPFILES=()
cleanup() { [ "${#TMPFILES[@]}" -gt 0 ] && rm -f "${TMPFILES[@]}"; return 0; }
trap cleanup EXIT

resolve_account
package_release

INSTANCE_ID="i-dryrun"
if ! is_dry; then
  INSTANCE_ID="$(find_instance)"
  [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] \
    || die "No browser-test instance found (tags $TAG_PROJECT_KEY=$TAG_PROJECT_VAL, $TAG_MANAGED_KEY=$TAG_MANAGED_VAL). Run deploy/aws/install.sh first."
  online="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)"
  [ "$online" = "Online" ] || die "Instance $INSTANCE_ID is not online in SSM (status: $online). Wait a few minutes after launch, or check the instance."
fi

CMD="$(fetch_and_setup_cmd "$BUCKET" "$RELEASE_SHA")"
mut "ssm send-command (AWS-RunShellScript) to $INSTANCE_ID: download release $RELEASE_SHA and run setup.sh" || {
  printf 'DRY_RUN command would be: %s\n' "$CMD" >&2
  exit 0
}

params="$(mktemp)"; TMPFILES+=("$params")
printf '{"commands":["%s"],"executionTimeout":["1800"]}\n' "$CMD" >"$params"
CMD_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment "browser-test update $RELEASE_SHA" --parameters "file://$params" \
  --query Command.CommandId --output text)"
info "Command $CMD_ID sent. Waiting for it to finish (up to 30 minutes)."

status="Pending"
for _ in $(seq 1 180); do
  sleep 10
  status="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$status" in Success|Failed|Cancelled|TimedOut|Cancelling) break ;; esac
done

aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -n 20 >&2 || true
[ "$status" = "Success" ] || die "Update ended with status '$status'. See the output above, or open a shell: aws ssm start-session --target $INSTANCE_ID"
info "Release $RELEASE_SHA is live. The next timer run uses it."
