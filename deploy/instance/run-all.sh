#!/usr/bin/env bash
# One monitoring cycle over ALL targets, one after another (started by browser-test.service).
# For each file /etc/browser-test/targets/<label>.env: switch the host resolver, run
# `npm start` unprivileged, upload the results, send the heartbeat, alert on a bad exit.
# One failing target never stops the others.
#
# Exit code: 0 once the loop ran (per-target alerts were already sent). Non-zero only for
# wrapper-level problems (no targets, no bucket config, resolver cannot be switched for any
# target), so the unit's OnFailure= alert fires for those.
#
# Every external command and path can be overridden by env so tests need no root or AWS.
set -euo pipefail
export LC_ALL=C   # glob order = sorted order, the same on every host

CONF_DIR="${CONF_DIR:-/etc/browser-test}"
APP="${APP:-/opt/browser-test/current}"
STATE_DIR="${STATE_DIR:-/var/lib/browser-test}"
NPM_CMD="${NPM_CMD:-npm start}"
AWS_CMD="${AWS_CMD:-aws}"
ALERT_CMD="${ALERT_CMD:-$APP/deploy/instance/alert.sh}"
SET_RESOLVER_CMD="${SET_RESOLVER_CMD:-}"            # empty = built-in switch below
# RUN_AS: prefix that drops privileges. Tests set it to the empty string.
RUN_AS="${RUN_AS-setpriv --reuid=browsertest --regid=browsertest --clear-groups}"
RUN_USER="${RUN_USER:-browsertest}"
LOCK_FILE="${LOCK_FILE:-$STATE_DIR/run.lock}"
TARGET_TIMEOUT="${TARGET_TIMEOUT:-20m}"
RESOLVED_CONF="${RESOLVED_CONF:-/etc/systemd/resolved.conf.d/browser-test.conf}"
SYSTEMCTL_CMD="${SYSTEMCTL_CMD:-systemctl}"
GETENT_CMD="${GETENT_CMD:-getent}"
RESOLVE_TEST_NAME="${RESOLVE_TEST_NAME:-example.com}"
RESOLVE_WAIT_S="${RESOLVE_WAIT_S:-20}"

log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$1" "${*:2}" >&2; }
die() { log ERROR "$@"; exit 2; }

BUCKET="$(cat "$CONF_DIR/bucket" 2>/dev/null)" || die "Cannot read $CONF_DIR/bucket. Re-run deploy/aws/install.sh."
[ -n "$BUCKET" ] || die "$CONF_DIR/bucket is empty. Re-run deploy/aws/install.sh."
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$(cat "$CONF_DIR/region" 2>/dev/null || true)}"

# Runs must never overlap: a slow cycle would otherwise load a resolver twice.
mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log WARN "Previous cycle still running, skipping this one. Is the sum of target times above the timer interval?"; exit 0; }

declare -a RUN_AS_A NPM_A
read -ra RUN_AS_A <<<"$RUN_AS"
read -ra NPM_A <<<"$NPM_CMD"

# Parses KEY=value lines (like a systemd EnvironmentFile: no export, optional quotes) into
# the associative array named by $2. Parsed, not sourced: the file can never run code.
load_env() {
  local file="$1" line k v
  local -n out="$2"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
    out["$k"]="$v"
  done <"$file"
}

# Built-in resolver switch: global DNS = the target's resolver, no fallback (a silent fallback
# would hide an outage and fake good results). The restart also clears the resolver cache,
# so ISPs never share cached answers. AWS names keep using the VPC resolver (per-link
# routing domain set by setup.sh), so uploads and alerts work whatever the target does.
switch_resolver() {
  local ip="$1" tmp
  if [ -n "$SET_RESOLVER_CMD" ]; then $SET_RESOLVER_CMD "$ip"; return; fi
  tmp="$RESOLVED_CONF.tmp"
  printf '# Managed by deploy/instance/run-all.sh. One target at a time, no fallback.\n[Resolve]\nDNS=%s\nDomains=~.\nFallbackDNS=\n' "$ip" >"$tmp"
  mv -f "$tmp" "$RESOLVED_CONF"
  $SYSTEMCTL_CMD restart systemd-resolved
}

wait_for_resolver() {
  local i
  for ((i = 0; i < RESOLVE_WAIT_S; i++)); do
    if $GETENT_CMD hosts "$RESOLVE_TEST_NAME" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  log WARN "$RESOLVE_TEST_NAME did not resolve within ${RESOLVE_WAIT_S}s. Continuing: the run will record the failures."
}

alert() { # label rc key
  "$ALERT_CMD" "$@" || log ERROR "Alert command failed for $1 (rc $2). Check SNS permissions and the topic file."
}

declare -A BASE=()
[ ! -f "$CONF_DIR/env" ] || load_env "$CONF_DIR/env" BASE
BASE_OUT="${BASE[OUT_DIR]:-$STATE_DIR/out}"
export OUT_DIR="$BASE_OUT"   # alert.sh reads <OUT_DIR>/<label>/summary.json

shopt -s nullglob
files=("$CONF_DIR"/targets/*.env)
[ "${#files[@]}" -gt 0 ] || die "No target files in $CONF_DIR/targets/. Add one with deploy/aws/add-target.sh <label> <ip>."

ran=0; switched=0
for f in "${files[@]}"; do
  label="$(basename "$f" .env)"
  if ! [[ "$label" =~ ^[A-Za-z0-9_-]{1,40}$ ]]; then
    log ERROR "Skipping target file '$(basename "$f")': the label must match [A-Za-z0-9_-]{1,40}."
    continue
  fi
  ran=$((ran + 1))
  declare -A ENVMAP=()
  for k in "${!BASE[@]}"; do ENVMAP["$k"]="${BASE[$k]}"; done
  load_env "$f" ENVMAP
  ip="${ENVMAP[RESOLVER_DNS_IP]:-}"

  stamp="$(date -u +%Y-%m-%d/%H%M%SZ)"
  key="results/resolver=$label/date=${stamp%/*}/${stamp#*/}"
  out="$BASE_OUT/$label"
  log INFO "Target $label: start"

  if ! [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    log ERROR "Target $label: RESOLVER_DNS_IP is missing or not an IPv4 address in $f."
    alert "$label" 2 "none"
    unset ENVMAP; continue
  fi
  if ! switch_resolver "$ip"; then
    log ERROR "Target $label: could not switch the resolver."
    alert "$label" 125 "none"
    unset ENVMAP; continue
  fi
  switched=$((switched + 1))
  wait_for_resolver

  # Old files would be uploaded as new if this run crashed before writing.
  rm -rf "$out"; mkdir -p "$out"
  [ -z "$RUN_AS" ] || chown -R "$RUN_USER:$RUN_USER" "$out"
  # Previous run of this label, for the trend. First run or a failed download = no trend.
  if $AWS_CMD s3 cp "s3://$BUCKET/results/resolver=$label/latest.json" "$out/previous-summary.json" --only-show-errors 2>/dev/null; then
    [ -z "$RUN_AS" ] || chown "$RUN_USER:$RUN_USER" "$out/previous-summary.json"
    ENVMAP[PREVIOUS_SUMMARY]="$out/previous-summary.json"
  else
    log INFO "Target $label: no previous summary in S3, so no trend this run"
  fi
  # The label always comes from the file name; a stale RESOLVER_LABEL in the env is ignored.
  ENVMAP[RESOLVER_LABEL]="$label"; ENVMAP[OUT_DIR]="$out"; ENVMAP[HOME]="${ENVMAP[HOME]:-$STATE_DIR}"
  declare -a envargs=()
  for k in "${!ENVMAP[@]}"; do envargs+=("$k=${ENVMAP[$k]}"); done

  rc=0
  (cd "$APP" && timeout --kill-after=30 "$TARGET_TIMEOUT" "${RUN_AS_A[@]}" env "PATH=$PATH" "${envargs[@]}" "${NPM_A[@]}") || rc=$?
  log INFO "Target $label: npm exited with $rc"

  # Upload on every exit code: a failed run is when the data matters.
  for name in page-summary.csv request-details.csv summary.json; do
    if [ -f "$out/$name" ]; then
      $AWS_CMD s3 cp "$out/$name" "s3://$BUCKET/$key/$name" --only-show-errors || log ERROR "Target $label: upload of $name failed. Check the instance role and DNS to AWS."
    else
      log WARN "Target $label: $name was not produced"
    fi
  done
  if [ -f "$out/summary.json" ]; then
    $AWS_CMD s3 cp "$out/summary.json" "s3://$BUCKET/results/resolver=$label/latest.json" --only-show-errors || log ERROR "Target $label: upload of latest.json failed."
  fi

  # Heartbeat only for runs that finished (0 or 1). Exit 2, a timeout or a crash sends none,
  # so the per-label alarm fires when a target is broken, not only when the timer is dead.
  if [ "$rc" = "0" ] || [ "$rc" = "1" ]; then
    $AWS_CMD cloudwatch put-metric-data --namespace BrowserTest --metric-name RunCompleted \
      --dimensions "Resolver=$label" --value 1 --unit Count || log ERROR "Target $label: heartbeat metric failed. The alarm may fire."
  fi
  [ "$rc" = "0" ] || alert "$label" "$rc" "$key"
  unset ENVMAP envargs
done

[ "$ran" -gt 0 ] || die "No valid target files in $CONF_DIR/targets/."
[ "$switched" -gt 0 ] || die "The resolver could not be switched for any target. Check systemd-resolved."
log INFO "Cycle finished: $ran target(s)."
exit 0
