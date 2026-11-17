#!/usr/bin/env bash
# Removes ONLY resources that carry this project's exact names or tags, and prints them first.
# Safe to run twice: missing resources are skipped.
#
# Optional env: AWS_PROFILE (Cybird-Dev), AWS_REGION (ap-south-1),
#               YES=1        skip the typed confirmation
#               PURGE_BUCKET=1  also empty and delete the results bucket (default: keep it)
#               DRY_RUN=1    print what would be looked up and deleted; no aws call at all
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/common.sh
. "$HERE/common.sh"

resolve_account
TOPIC_ARN="arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"

if is_dry; then
  cat >&2 <<PLAN
DRY_RUN would: look up by tag ($TAG_PROJECT_KEY=$TAG_PROJECT_VAL, $TAG_MANAGED_KEY=$TAG_MANAGED_VAL) or exact name, then delete:
DRY_RUN would: - CloudWatch alarm $ALARM_NAME
DRY_RUN would: - EC2 instance(s) with those tags (terminate), then the tagged Elastic IP (release)
DRY_RUN would: - security group $SG_NAME (tagged)
DRY_RUN would: - instance profile $PROFILE_NAME and role $ROLE_NAME (with its policies), if tagged
DRY_RUN would: - SNS topic $TOPIC_NAME and its subscriptions, if tagged
DRY_RUN would: - bucket $BUCKET only if PURGE_BUCKET=1 (currently: ${PURGE_BUCKET:-0}), and only if tagged
DRY_RUN would: ask for typed confirmation unless YES=1
PLAN
  exit 0
fi

# aws returns "None" or empty for a missing item; normalise to empty.
norm() { local v; v="$(cat)"; [ "$v" = "None" ] && v=""; printf '%s' "$v"; }
has_tags() { # $1 = text of "Key<TAB>Value" lines
  printf '%s\n' "$1" | grep -qx "${TAG_PROJECT_KEY}"$'\t'"${TAG_PROJECT_VAL}" \
    && printf '%s\n' "$1" | grep -qx "${TAG_MANAGED_KEY}"$'\t'"${TAG_MANAGED_VAL}"
}

# --- Discover (read-only) ---
INSTANCES="$(aws ec2 describe-instances --filters "${TAG_FILTERS[@]}" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text | norm)"
EIPS="$(aws ec2 describe-addresses --filters "${TAG_FILTERS[@]}" --query 'Addresses[].AllocationId' --output text | norm)"
SGS="$(aws ec2 describe-security-groups --filters "${TAG_FILTERS[@]}" --query 'SecurityGroups[].GroupId' --output text | norm)"
ALARM="$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --query 'MetricAlarms[0].AlarmName' --output text | norm)"

ROLE=""
if tags="$(aws iam list-role-tags --role-name "$ROLE_NAME" --query 'Tags[].[Key,Value]' --output text 2>/dev/null)" && has_tags "$tags"; then ROLE="$ROLE_NAME"; fi
PROFILE=""
if tags="$(aws iam list-instance-profile-tags --instance-profile-name "$PROFILE_NAME" --query 'Tags[].[Key,Value]' --output text 2>/dev/null)" && has_tags "$tags"; then PROFILE="$PROFILE_NAME"; fi
TOPIC=""
if tags="$(aws sns list-tags-for-resource --resource-arn "$TOPIC_ARN" --query 'Tags[].[Key,Value]' --output text 2>/dev/null)" && has_tags "$tags"; then TOPIC="$TOPIC_ARN"; fi
BUCKET_DEL=""
if [ "${PURGE_BUCKET:-0}" = "1" ]; then
  if tags="$(aws s3api get-bucket-tagging --bucket "$BUCKET" --query 'TagSet[].[Key,Value]' --output text 2>/dev/null)" && has_tags "$tags"; then BUCKET_DEL="$BUCKET"; else warn "Bucket $BUCKET is missing or not tagged for this project: leaving it alone."; fi
fi

echo "The following resources (account $ACCOUNT_ID, region $AWS_REGION) will be DELETED:" >&2
printf '  alarm            : %s\n  instances        : %s\n  elastic ip ids   : %s\n  security groups  : %s\n  instance profile : %s\n  iam role         : %s\n  sns topic        : %s\n  bucket           : %s\n' \
  "${ALARM:--}" "${INSTANCES:--}" "${EIPS:--}" "${SGS:--}" "${PROFILE:--}" "${ROLE:--}" "${TOPIC:--}" "${BUCKET_DEL:-- (kept)}" >&2

if [ -z "$ALARM$INSTANCES$EIPS$SGS$PROFILE$ROLE$TOPIC$BUCKET_DEL" ]; then info "Nothing to delete."; exit 0; fi

if [ "${YES:-0}" != "1" ]; then
  [ -t 0 ] || die "No terminal for the confirmation. Re-run in a terminal, or set YES=1."
  printf 'Type "delete browser-test" to continue: ' >&2
  read -r reply
  [ "$reply" = "delete browser-test" ] || die "Confirmation text did not match. Nothing was deleted."
fi

# --- Delete (order matters: dependants first) ---
[ -z "$ALARM" ] || { info "Deleting alarm"; aws cloudwatch delete-alarms --alarm-names "$ALARM"; }

if [ -n "$INSTANCES" ]; then
  info "Terminating $INSTANCES"
  # shellcheck disable=SC2086
  aws ec2 terminate-instances --instance-ids $INSTANCES >/dev/null
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --instance-ids $INSTANCES
fi
for a in $EIPS; do
  info "Releasing Elastic IP $a"
  assoc="$(aws ec2 describe-addresses --allocation-ids "$a" --query 'Addresses[0].AssociationId' --output text | norm)"
  [ -z "$assoc" ] || aws ec2 disassociate-address --association-id "$assoc"
  aws ec2 release-address --allocation-id "$a"
done
for g in $SGS; do
  info "Deleting security group $g"
  # The network interface of a terminated instance can linger for a minute.
  for _ in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$g" 2>/dev/null && break || sleep 10; done
  if aws ec2 describe-security-groups --group-ids "$g" >/dev/null 2>&1; then warn "Security group $g still exists (in use?). Re-run uninstall.sh later."; fi
done
if [ -n "$PROFILE" ]; then
  info "Deleting instance profile"
  for r in $(aws iam get-instance-profile --instance-profile-name "$PROFILE" --query 'InstanceProfile.Roles[].RoleName' --output text); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE" --role-name "$r"
  done
  aws iam delete-instance-profile --instance-profile-name "$PROFILE"
fi
if [ -n "$ROLE" ]; then
  info "Deleting role"
  for p in $(aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$ROLE" --policy-arn "$p"
  done
  for p in $(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$ROLE" --policy-name "$p"
  done
  aws iam delete-role --role-name "$ROLE"
fi
if [ -n "$TOPIC" ]; then
  info "Deleting SNS topic (delete-topic also removes its subscriptions)"
  aws sns delete-topic --topic-arn "$TOPIC"
fi
if [ -n "$BUCKET_DEL" ]; then
  info "Emptying and deleting bucket $BUCKET_DEL"
  aws s3 rm "s3://$BUCKET_DEL" --recursive --only-show-errors
  aws s3api delete-bucket --bucket "$BUCKET_DEL"
elif [ "${PURGE_BUCKET:-0}" != "1" ]; then
  info "Bucket $BUCKET kept (results stay). Set PURGE_BUCKET=1 to delete it."
fi
info "Uninstall finished."
