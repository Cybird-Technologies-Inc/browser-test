#!/usr/bin/env bash
# Shared helpers for install.sh, update.sh and uninstall.sh. Source it; do not run it.
# Why one shared file: the three scripts must agree on resource names and tags,
# because uninstall finds resources only by these exact names and tags.
set -euo pipefail

# Region and profile are overridable. Defaults are the owner's standard.
export AWS_PROFILE="${AWS_PROFILE:-Cybird-Dev}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

PREFIX="browser-test"
TAG_PROJECT_KEY="Project"
TAG_PROJECT_VAL="browser-test"
TAG_MANAGED_KEY="ManagedBy"
TAG_MANAGED_VAL="deploy/aws/install.sh"
TOPIC_NAME="browser-test-alerts"
ROLE_NAME="browser-test-instance-role"
PROFILE_NAME="browser-test-instance-profile"
SG_NAME="browser-test-sg"
# One heartbeat alarm per resolver label: browser-test-heartbeat-<label>.
# LEGACY_ALARM_NAME is the single-target name from the first version (migration only).
ALARM_PREFIX="browser-test-heartbeat-"
LEGACY_ALARM_NAME="browser-test-heartbeat-missing"
METRIC_NAMESPACE="BrowserTest"
METRIC_NAME="RunCompleted"
# No default: the label names the resolver under test and must be chosen by the operator.
RESOLVER_LABEL="${RESOLVER_LABEL:-}"
DRY_ACCOUNT_ID="000000000000"

# Log levels go to stderr so stdout stays clean for values.
log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$1" "${*:2}" >&2; }
info() { log INFO "$@"; }
warn() { log WARN "$@"; }
err() { log ERROR "$@"; }
die() { err "$@"; exit 1; }

is_dry() { [ "${DRY_RUN:-0}" = "1" ]; }

# Use as: mut "what it does" || return 0   (prints the plan in DRY_RUN and skips).
mut() {
  if is_dry; then
    printf 'DRY_RUN would: %s\n' "$*" >&2
    return 1
  fi
  info "$*"
  return 0
}

# Fail fast with a message that says what to set.
need_env() {
  local name="$1" hint="$2"
  if [ -z "${!name:-}" ]; then
    die "Required variable $name is not set. $hint"
  fi
}

# A real run needs the AWS CLI; DRY_RUN never calls it, so it is not required there.
require_aws() {
  command -v aws >/dev/null 2>&1 || die "AWS CLI v2 not found. Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  aws --version 2>&1 | grep -q 'aws-cli/2' || die "AWS CLI v2 is required (found: $(aws --version 2>&1 | cut -c1-40))."
}

# Sets ACCOUNT_ID and BUCKET. In DRY_RUN there is no aws call, so a placeholder is used.
resolve_account() {
  if is_dry; then
    ACCOUNT_ID="$DRY_ACCOUNT_ID"
    warn "DRY_RUN: using placeholder account id $DRY_ACCOUNT_ID (no aws call is made)."
  else
    require_aws
    ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
      || die "aws sts get-caller-identity failed for profile '$AWS_PROFILE'. Run: aws sso login --profile $AWS_PROFILE (or fix AWS_PROFILE)."
    info "Using AWS account $ACCOUNT_ID, region $AWS_REGION, profile $AWS_PROFILE."
  fi
  BUCKET="cybird-browser-test-results-${ACCOUNT_ID}"
}

# Tag filters for describe-* calls: both tags must match.
TAG_FILTERS=("Name=tag:${TAG_PROJECT_KEY},Values=${TAG_PROJECT_VAL}" "Name=tag:${TAG_MANAGED_KEY},Values=${TAG_MANAGED_VAL}")

# Prints the id of the (single) non-terminated instance, or nothing.
find_instance() {
  aws ec2 describe-instances --filters "${TAG_FILTERS[@]}" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}'
}

# Builds the release tarball from HEAD and uploads it. Sets RELEASE_SHA and RELEASE_KEY.
# Why git archive: the instance gets exactly what is committed, no node_modules or CSVs.
package_release() {
  local root tmp
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git checkout. Run this from the browser-test repo."
  cd "$root"
  if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
      warn "Uncommitted tracked changes exist. They are NOT in the release (git archive HEAD). ALLOW_DIRTY=1 set."
    else
      die "Uncommitted tracked changes found. Commit them (the release is built from HEAD), or set ALLOW_DIRTY=1 to deploy HEAD anyway."
    fi
  fi
  if ! git cat-file -e HEAD:deploy/instance/setup.sh 2>/dev/null; then
    if is_dry; then
      warn "deploy/instance/setup.sh is not committed yet. A real run would stop here: commit deploy/ first."
    else
      die "deploy/instance/setup.sh is not in HEAD. Commit the deploy/ folder first: the release is built from HEAD."
    fi
  fi
  RELEASE_SHA="$(git rev-parse --short=10 HEAD)"
  RELEASE_KEY="releases/browser-test-${RELEASE_SHA}.tgz"
  mut "git archive HEAD to browser-test-${RELEASE_SHA}.tgz and upload to s3://${BUCKET}/${RELEASE_KEY}" || return 0
  tmp="$(mktemp)"
  git archive --format=tar.gz HEAD -o "$tmp"
  aws s3 cp "$tmp" "s3://${BUCKET}/${RELEASE_KEY}" --only-show-errors
  rm -f "$tmp"
}

# One-line root command that downloads a release and runs setup.sh. No quotes on purpose:
# it is embedded in user-data and in an SSM JSON parameter, and quotes would need escaping.
# The directory only becomes /opt/browser-test/<sha> once fully extracted (mv is atomic).
fetch_and_setup_cmd() {
  local b="$1" sha="$2" d="/opt/browser-test/$2"
  printf '%s' "mkdir -p /opt/browser-test/releases && aws s3 cp s3://${b}/releases/browser-test-${sha}.tgz /opt/browser-test/releases/ --only-show-errors && rm -rf ${d}.tmp && mkdir -p ${d}.tmp && tar -xzf /opt/browser-test/releases/browser-test-${sha}.tgz -C ${d}.tmp && if [ -d ${d} ]; then rm -rf ${d}.tmp; else mv ${d}.tmp ${d}; fi && bash ${d}/deploy/instance/setup.sh"
}

# Label = target file name on the instance and the metric dimension. Strict on purpose:
# it ends up in file names, S3 keys and shell commands.
valid_label() { printf '%s' "${1:-}" | grep -Eq '^[A-Za-z0-9_-]{1,40}$'; }
valid_ipv4() {
  printf '%s' "${1:-}" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  local o; for o in ${1//./ }; do [ "$o" -le 255 ] || return 1; done
}

# Creates or updates the heartbeat alarm of one label. Needs TOPIC_ARN.
# Missing data counts as breaching: a dead timer sends no metric, and that must alert.
put_heartbeat_alarm() {
  local label="$1"
  mut "put alarm ${ALARM_PREFIX}${label}: $METRIC_NAMESPACE/$METRIC_NAME Resolver=$label, period 900 s x 3, missing data = breaching, action = SNS topic" || return 0
  aws cloudwatch put-metric-alarm --alarm-name "${ALARM_PREFIX}${label}" \
    --alarm-description "No browser-test run completed for resolver '$label' in 45 minutes (timer, instance or target is down)" \
    --namespace "$METRIC_NAMESPACE" --metric-name "$METRIC_NAME" --dimensions "Name=Resolver,Value=$label" \
    --statistic Sum --period 900 --evaluation-periods 3 --threshold 1 \
    --comparison-operator LessThanThreshold --treat-missing-data breaching \
    --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN" \
    --tags "Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}" "Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}"
}

# Instance lookup for scripts that act on a running instance (add/remove target).
require_instance() {
  INSTANCE_ID="i-dryrun"
  is_dry && return 0
  INSTANCE_ID="$(find_instance)"
  [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] \
    || die "No browser-test instance found (tags $TAG_PROJECT_KEY=$TAG_PROJECT_VAL, $TAG_MANAGED_KEY=$TAG_MANAGED_VAL). Run deploy/aws/install.sh first."
}

# Runs one shell command line as root on the instance via SSM and waits. Needs INSTANCE_ID.
# Output goes to stderr (tail); returns non-zero unless the command succeeded.
ssm_run() {
  local cmd="$1" params id status="Pending"
  params="$(mktemp)"
  printf '{"commands":["%s"]}\n' "$cmd" >"$params"
  id="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --parameters "file://$params" --query Command.CommandId --output text)" || { rm -f "$params"; return 1; }
  rm -f "$params"
  for _ in $(seq 1 60); do
    sleep 5
    status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -n 10 >&2 || true
  [ "$status" = "Success" ]
}
