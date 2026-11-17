#!/usr/bin/env bash
# Creates everything the browser-test monitoring runner needs in one AWS account.
# Safe to run twice: every step looks up the resource by exact name or tag first.
#
# Required env:  ALERT_EMAIL     address that receives alerts (never stored in the repo)
#                RESOLVER_DNS_IP   IPv4 of the resolver under test (never stored in the repo)
#                RESOLVER_LABEL  short name of the resolver under test, for example the ISP name
#                VPC_ID          VPC to launch in (no default VPC is assumed)
#                SUBNET_ID       public subnet in that VPC (route to an internet gateway)
# Optional env:  AWS_PROFILE (Cybird-Dev), AWS_REGION (ap-south-1), INSTANCE_TYPE (t3.small),
#                ALLOW_DIRTY=1, DRY_RUN=1 (no aws call at all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/common.sh
. "$HERE/common.sh"

need_env ALERT_EMAIL "Set it to the address that should receive alerts, for example: export ALERT_EMAIL=you@your-domain"
# Deprecated name from the first version of this script; remove after one release.
if [ -z "${RESOLVER_DNS_IP:-}" ] && [ -n "${LEOHAT_DNS_IP:-}" ]; then
  warn "LEOHAT_DNS_IP is deprecated. Use RESOLVER_DNS_IP."
  RESOLVER_DNS_IP="$LEOHAT_DNS_IP"
fi
need_env RESOLVER_LABEL "Set it to a short name for the resolver under test, for example: export RESOLVER_LABEL=<isp-name>"
if ! printf '%s' "$RESOLVER_LABEL" | grep -Eq '^[A-Za-z0-9_-]{1,40}$'; then
  die "RESOLVER_LABEL may only contain letters, digits, - and _ (max 40)."
fi
need_env RESOLVER_DNS_IP "Set it to the IPv4 address of the resolver under test, for example: export RESOLVER_DNS_IP=<ip>"
need_env VPC_ID "Set it to the VPC to launch in (aws ec2 describe-vpcs). The script never assumes a default VPC."
need_env SUBNET_ID "Set it to a public subnet of VPC_ID (aws ec2 describe-subnets): it needs a route to an internet gateway."
if ! printf '%s' "$RESOLVER_DNS_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  die "RESOLVER_DNS_IP must be a plain IPv4 address."
fi
case "$ALERT_EMAIL" in *@*.*) ;; *) die "ALERT_EMAIL does not look like an email address." ;; esac

INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
AMI_PARAM="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
TMPFILES=()
cleanup() { [ "${#TMPFILES[@]}" -gt 0 ] && rm -f "${TMPFILES[@]}"; return 0; }
trap cleanup EXIT

resolve_account
TOPIC_ARN="arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"
TAG_LIST="Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL} Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}"
# shellcheck disable=SC2206
TAGS=($TAG_LIST)

step_bucket() {
  info "Step 1: S3 bucket $BUCKET"
  if ! is_dry && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    info "Bucket exists, re-applying settings."
  else
    mut "create private bucket $BUCKET in $AWS_REGION" || true
    if ! is_dry; then
      aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
        --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    fi
  fi
  mut "block all public access, enable SSE-S3, tag the bucket" || true
  if ! is_dry; then
    aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging \
      "TagSet=[{Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}},{Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}}]"
  fi
  # Versioning stays off. The noncurrent rule is a no-op until someone enables versioning.
  mut "lifecycle: expire results/ after 90 days, releases/ noncurrent versions after 30 days" || return 0
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
    "Rules": [
      {"ID":"expire-results-90d","Status":"Enabled","Filter":{"Prefix":"results/"},
       "Expiration":{"Days":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}},
      {"ID":"expire-old-releases","Status":"Enabled","Filter":{"Prefix":"releases/"},
       "NoncurrentVersionExpiration":{"NoncurrentDays":30},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}
    ]}'
}

step_sns() {
  info "Step 2: SNS topic $TOPIC_NAME and email subscription"
  mut "create topic $TOPIC_NAME (create-topic returns the existing one if present) and tag it" || true
  if ! is_dry; then
    aws sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text >/dev/null
    aws sns tag-resource --resource-arn "$TOPIC_ARN" --tags "${TAGS[@]}"
  fi
  local existing=""
  if ! is_dry; then
    existing="$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
      --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'].SubscriptionArn" --output text)"
  fi
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    info "ALERT_EMAIL is already subscribed (state: $([ "$existing" = "PendingConfirmation" ] && echo pending || echo confirmed))."
    return 0
  fi
  mut "subscribe ALERT_EMAIL to $TOPIC_ARN (a confirmation mail will be sent)" || return 0
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
  warn "ACTION NEEDED: open the confirmation mail sent to ALERT_EMAIL and click 'Confirm subscription'. No alert is delivered before that."
}

step_iam() {
  info "Step 3: IAM role $ROLE_NAME and instance profile $PROFILE_NAME"
  local created=0
  mut "create role $ROLE_NAME (trust: ec2.amazonaws.com) if missing" || true
  if ! is_dry; then
    if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
      aws iam create-role --role-name "$ROLE_NAME" --tags "${TAGS[@]}" \
        --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
      created=1
    fi
  fi
  mut "attach AmazonSSMManagedInstanceCore (shell access without SSH)" || true
  if ! is_dry; then
    aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  fi
  # Least privilege: each action is limited to one prefix or one ARN. PutMetricData cannot be
  # limited by resource, so it carries a namespace condition instead.
  local policy
  policy='{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "PutResults", "Effect": "Allow", "Action": "s3:PutObject",
     "Resource": "arn:aws:s3:::'"$BUCKET"'/results/*"},
    {"Sid": "GetLatestForTrend", "Effect": "Allow", "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::'"$BUCKET"'/results/resolver=*/latest.json"},
    {"Sid": "GetReleases", "Effect": "Allow", "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::'"$BUCKET"'/releases/*"},
    {"Sid": "PublishAlerts", "Effect": "Allow", "Action": "sns:Publish",
     "Resource": "'"$TOPIC_ARN"'"},
    {"Sid": "Heartbeat", "Effect": "Allow", "Action": "cloudwatch:PutMetricData",
     "Resource": "*",
     "Condition": {"StringEquals": {"cloudwatch:namespace": "'"$METRIC_NAMESPACE"'"}}}
  ]
}'
  mut "put inline policy browser-test-runtime on the role (S3 results/ put, releases/ get, SNS publish, namespaced metric)" || true
  if ! is_dry; then
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name browser-test-runtime --policy-document "$policy"
  fi
  mut "create instance profile $PROFILE_NAME and add the role" || return 0
  if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" --tags "${TAGS[@]}" >/dev/null
    created=1
  fi
  if [ "$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" --query 'length(InstanceProfile.Roles)' --output text)" = "0" ]; then
    aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
    created=1
  fi
  # IAM is eventually consistent: a new profile is not always usable by EC2 at once.
  if [ "$created" = "1" ]; then info "Waiting 15 s for IAM to propagate."; sleep 15; fi
}

step_sg() {
  info "Step 4: security group $SG_NAME (no inbound rules)"
  SG_ID="sg-dryrun"
  mut "check SUBNET_ID belongs to VPC_ID, create security group $SG_NAME in $VPC_ID with NO inbound rules (egress stays open for DNS, HTTPS)" || return 0
  local vpc="$VPC_ID" subnet_vpc
  subnet_vpc="$(aws ec2 describe-subnets --subnet-ids "$SUBNET_ID" --query 'Subnets[0].VpcId' --output text)"
  [ "$subnet_vpc" = "$vpc" ] || die "SUBNET_ID $SUBNET_ID is in $subnet_vpc, not in VPC_ID $vpc. Pick a subnet of that VPC."
  SG_ID="$(aws ec2 describe-security-groups --filters "${TAG_FILTERS[@]}" "Name=vpc-id,Values=$vpc" --query 'SecurityGroups[0].GroupId' --output text)"
  if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    SG_ID="$(aws ec2 create-security-group --group-name "$SG_NAME" --description "browser-test runner: no inbound" \
      --vpc-id "$vpc" --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$SG_NAME},{Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}},{Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}}]" \
      --query GroupId --output text)"
  fi
  info "Security group: $SG_ID"
}

write_user_data() {
  local f="$1"
  # The setup runs as root on first boot. Files holding values are written here so that
  # no value appears on a command line. user-data is readable by principals that may call
  # ec2:DescribeInstanceAttribute: the DNS IP is not a secret, but keep that scope tight.
  cat >"$f" <<UD
#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/browser-test-userdata.log) 2>&1
install -d -m 0755 /etc/browser-test
install -m 0600 /dev/null /etc/browser-test/resolver-dns
printf '%s\n' '${RESOLVER_DNS_IP}' > /etc/browser-test/resolver-dns
printf '%s\n' '${BUCKET}' > /etc/browser-test/bucket
printf '%s\n' '${TOPIC_ARN}' > /etc/browser-test/sns-topic-arn
printf '%s\n' '${AWS_REGION}' > /etc/browser-test/region
printf '%s\n' '${RESOLVER_LABEL}' > /etc/browser-test/resolver-label
chmod 0644 /etc/browser-test/bucket /etc/browser-test/sns-topic-arn /etc/browser-test/region /etc/browser-test/resolver-label
# First target: one file per resolver under test. More are added with deploy/aws/add-target.sh.
install -d -m 0755 /etc/browser-test/targets
if [ ! -f '/etc/browser-test/targets/${RESOLVER_LABEL}.env' ]; then
  printf 'RESOLVER_DNS_IP=%s\n' '${RESOLVER_DNS_IP}' > '/etc/browser-test/targets/${RESOLVER_LABEL}.env'
  chmod 0644 '/etc/browser-test/targets/${RESOLVER_LABEL}.env'
fi
export DEBIAN_FRONTEND=noninteractive
export AWS_DEFAULT_REGION='${AWS_REGION}'
apt-get update -y
apt-get install -y curl unzip ca-certificates
# Ubuntu 24.04 has no apt awscli package (removed), and the snap is avoided on purpose:
# the official v2 installer is the supported route.
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip
fi
$(fetch_and_setup_cmd "$BUCKET" "$RELEASE_SHA")
UD
}

step_instance() {
  info "Step 5: release package and EC2 instance"
  package_release
  INSTANCE_ID="i-dryrun"
  local existing=""
  if ! is_dry; then existing="$(find_instance)"; fi
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    INSTANCE_ID="$existing"
    warn "Instance $INSTANCE_ID already exists, not launching another. To deploy a new version run deploy/aws/update.sh."
    return 0
  fi
  local ud ami
  ud="$(mktemp)"; TMPFILES+=("$ud"); chmod 600 "$ud"
  write_user_data "$ud"
  mut "resolve Ubuntu 24.04 AMI from SSM parameter $AMI_PARAM" || true
  mut "launch ONE $INSTANCE_TYPE instance: IMDSv2 required, hop limit 1, encrypted gp3 20 GB root, no key pair, profile $PROFILE_NAME, security group $SG_NAME" || return 0
  ami="$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)"
  INSTANCE_ID="$(aws ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" --count 1 \
    --iam-instance-profile "Name=$PROFILE_NAME" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --user-data "file://$ud" \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Name,Value=$PREFIX},{Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}},{Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}}]" \
      "ResourceType=volume,Tags=[{Key=Name,Value=$PREFIX},{Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}},{Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}}]" \
    --query 'Instances[0].InstanceId' --output text)"
  info "Launched $INSTANCE_ID, waiting until it runs."
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
}

step_eip() {
  info "Step 6: Elastic IP"
  EIP="<elastic-ip-after-real-run>"
  mut "reuse a tagged Elastic IP or allocate one, then associate it with the instance" || return 0
  local alloc
  alloc="$(aws ec2 describe-addresses --filters "${TAG_FILTERS[@]}" --query 'Addresses[0].AllocationId' --output text)"
  if [ -z "$alloc" ] || [ "$alloc" = "None" ]; then
    alloc="$(aws ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$PREFIX},{Key=${TAG_PROJECT_KEY},Value=${TAG_PROJECT_VAL}},{Key=${TAG_MANAGED_KEY},Value=${TAG_MANAGED_VAL}}]" \
      --query AllocationId --output text)"
  fi
  # associate-address with the same instance is a no-op, so this is safe to repeat.
  aws ec2 associate-address --allocation-id "$alloc" --instance-id "$INSTANCE_ID" >/dev/null
  EIP="$(aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].PublicIp' --output text)"
}

step_alarm() {
  info "Step 7: heartbeat alarm ${ALARM_PREFIX}${RESOLVER_LABEL}"
  put_heartbeat_alarm "$RESOLVER_LABEL"
  # Migration: the first version had one alarm named browser-test-heartbeat-missing.
  # It is replaced by the per-label alarm above, so remove it (by exact name) if present.
  mut "delete legacy alarm $LEGACY_ALARM_NAME if it exists" || return 0
  if [ "$(aws cloudwatch describe-alarms --alarm-names "$LEGACY_ALARM_NAME" --query 'length(MetricAlarms)' --output text)" != "0" ]; then
    aws cloudwatch delete-alarms --alarm-names "$LEGACY_ALARM_NAME"
  fi
}

step_bucket
step_sns
step_iam
step_sg
step_instance
step_eip
step_alarm

cat >&2 <<OUT

Done$(is_dry && echo " (DRY_RUN: nothing was created)").
  Elastic IP : ${EIP:-n/a}
               -> Add this IP to the resolver's approved networks. Until then the resolver will not answer and runs will fail.
  Instance   : ${INSTANCE_ID:-n/a}   (first boot takes about 5 to 10 minutes)
  Bucket     : ${BUCKET}
  Shell      : aws ssm start-session --target ${INSTANCE_ID:-<instance-id>} --profile ${AWS_PROFILE} --region ${AWS_REGION}
  Next       : click the confirmation link in the SNS mail sent to ALERT_EMAIL.
  Rollback   : deploy/aws/uninstall.sh   (set PURGE_BUCKET=1 to delete the bucket too)
OUT
