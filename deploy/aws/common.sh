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
ALARM_NAME="browser-test-heartbeat-missing"
METRIC_NAMESPACE="BrowserTest"
METRIC_NAME="RunCompleted"
RESOLVER_LABEL="${RESOLVER_LABEL:-leohat}"
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
