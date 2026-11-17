# browser-test: AWS monitoring runner

This folder deploys one small EC2 instance that runs `npm start` (the light
profile) every 15 minutes. It measures page-load and DNS timings through the
LeoHat resolver, stores results in S3 and alerts by email.

No Terraform. Bash and the AWS CLI v2 only. Every script is safe to run twice.

## What gets created

All names start with `browser-test`. All resources are tagged
`Project=browser-test` and `ManagedBy=deploy/aws/install.sh`.

| Resource | Name | Purpose |
|----------|------|---------|
| S3 bucket | `cybird-browser-test-results-<account id>` | Results (`results/`, deleted after 90 days) and releases (`releases/`) |
| SNS topic + email subscription | `browser-test-alerts` | Alert delivery |
| IAM role + instance profile | `browser-test-instance-role`, `browser-test-instance-profile` | Least-privilege access (see Security) |
| Security group | `browser-test-sg` | No inbound rules |
| EC2 instance | `browser-test` (default `t3.small`, Ubuntu 24.04) | Runs the timer |
| Elastic IP | `browser-test` | Fixed source IP for the LeoHat approved networks |
| CloudWatch alarm | `browser-test-heartbeat-missing` | Fires when no run completed for 45 minutes |

On the instance:

| Item | Where |
|------|-------|
| App releases | `/opt/browser-test/<sha>`, symlink `/opt/browser-test/current` |
| Settings (edit here) | `/etc/browser-test/env` |
| Run output | `/var/lib/browser-test/out` |
| Timer and units | `browser-test.timer`, `browser-test.service`, `browser-test-alert.service` |

## Cost

About 15 USD per month, mostly the `t3.small` instance (about 15 USD in
`ap-south-1` at on-demand price). The 20 GB disk, the Elastic IP in use, S3
and CloudWatch add a few cents to about one USD. Check the current AWS prices.

## Prerequisites

- AWS CLI v2 and a profile that can create the resources above. Default profile: `Cybird-Dev`.
- `git`, run from a checkout of this repo.
- The `deploy/` folder must be **committed**: the release is built with `git archive HEAD`.
- An email address for alerts, and the IPv4 address of the LeoHat resolver.

## Environment variables

| Variable | Needed by | Default | Meaning |
|----------|-----------|---------|---------|
| `ALERT_EMAIL` | install | none, required | Alert recipient. Never written to the repo |
| `LEOHAT_DNS_IP` | install | none, required | LeoHat resolver IPv4. Never written to the repo |
| `AWS_PROFILE` | all | `Cybird-Dev` | AWS CLI profile |
| `AWS_REGION` | all | `ap-south-1` | Region |
| `INSTANCE_TYPE` | install | `t3.small` | Instance size |
| `RESOLVER_LABEL` | install, update | `leohat` | Metric dimension for the heartbeat. Keep equal to the label in `/etc/browser-test/env` |
| `ALLOW_DIRTY` | install, update | unset | `1` deploys HEAD even if tracked files have uncommitted changes (they are not included) |
| `DRY_RUN` | all | unset | `1` prints every action and calls no `aws` command. The account id shows as `000000000000` |
| `YES` | uninstall | unset | `1` skips the typed confirmation |
| `PURGE_BUCKET` | uninstall | unset | `1` also empties and deletes the results bucket |

## Install

1. Log in: `aws sso login --profile Cybird-Dev` (or your usual method).
2. Commit your changes so `HEAD` holds the release you want.
3. Preview, with no AWS calls:

   ```bash
   export ALERT_EMAIL=<your address> LEOHAT_DNS_IP=<resolver ip>
   DRY_RUN=1 deploy/aws/install.sh
   ```

4. Install for real: `deploy/aws/install.sh`
5. **Confirm the SNS email.** AWS sends a mail to `ALERT_EMAIL`. Click
   "Confirm subscription". Without this click no alert is delivered.
6. **Add the Elastic IP to the LeoHat approved networks.** The script prints the
   IP at the end. LeoHat answers only approved networks, so runs fail until this is done.
7. Wait 5 to 10 minutes for the first boot.

## First-run check

```bash
aws ssm start-session --target <instance-id> --profile Cybird-Dev --region ap-south-1
sudo tail -n 50 /var/log/browser-test-userdata.log   # setup finished?
sudo systemctl start browser-test.service            # run once now
sudo journalctl -u browser-test -n 50 --no-pager
sudo resolvectl status                               # LeoHat global, VPC resolver for amazonaws.com only
```

Then check that `s3://<bucket>/results/resolver=leohat/latest.json` exists.
After the first completed run the heartbeat alarm turns to OK.

## Update

Commit, then run `deploy/aws/update.sh`. It uploads the new release and runs
`setup.sh` on the instance through SSM. `/etc/browser-test/env` is kept.

## Change the profile or thresholds

`/etc/browser-test/env` is written once from `profiles/light.env` and never
overwritten, so your edits survive updates.

```bash
aws ssm start-session --target <instance-id> --profile Cybird-Dev
sudo nano /etc/browser-test/env   # for example MAX_P95_DNS_MS=300
```

The next timer run reads the file. Do not change `OUT_DIR` or `RESOLVER_LABEL`
unless you also set `RESOLVER_LABEL` for the install, or the heartbeat alarm will not match.

## Heavy profile: on demand only

Do **not** run `heavy-start.env` or `heavy.env` against LeoHat without the
owner's agreement. LeoHat serves real subscribers. The light `t3.small` is too
small for them. If agreed, use a separate, larger, temporary instance, run the
profile by hand from a shell (never from the timer), and delete the instance after.

## Rollback and uninstall

```bash
DRY_RUN=1 deploy/aws/uninstall.sh   # preview
deploy/aws/uninstall.sh             # lists what it found, asks you to type a confirmation
```

It deletes only resources with the exact names and tags above. The results
bucket is kept unless `PURGE_BUCKET=1`. To roll back a bad release only, check out
the previous commit and run `deploy/aws/update.sh`.

## Security notes

- The instance has no inbound rules and no key pair. Shell access is through SSM Session Manager.
- IMDSv2 is required with hop limit 1. The root disk is encrypted.
- The instance role can only: put objects under `results/`, get objects under
  `releases/`, publish to the one SNS topic, and put metrics in the `BrowserTest`
  namespace (the one action that cannot be limited by resource).
- The bucket blocks all public access and uses SSE-S3.
- Chromium runs as the unprivileged user `browsertest`, in a hardened systemd unit.
- To keep the Chromium sandbox working on Ubuntu 24.04, `setup.sh` installs a small AppArmor profile
  that allows user namespaces for the Playwright browser binaries only. The host-wide restriction stays on,
  and the app never runs with `--no-sandbox`.
- `LEOHAT_DNS_IP` is in the instance user-data (readable by principals with `ec2:DescribeInstanceAttribute`) and in a root-only file. It is not a secret, but it is not public.
- DNS has no fallback on purpose. If LeoHat is down, runs fail and alert, instead of silently measuring a public resolver. AWS endpoints use the VPC resolver so alerts and uploads still work.
- Node is pinned and checked against `SHASUMS256.txt` from the same release.
  This detects corruption, not a compromised nodejs.org.

## Known limits

- One instance. If it dies, there are no runs until you re-run `install.sh`; the heartbeat alarm tells you.
- The heartbeat alarm covers a dead timer or instance. It does not detect a run that exits 0 with useless data.
- `t3.small` is enough for the light profile only.
- If the AWS-side DNS bypass or the LeoHat link fails to apply, check `resolvectl status` first.
- The scripts were written without a live AWS test. Run `DRY_RUN=1` first, and watch the first install.

## Turn on the feed-category check

The runner can check that each LeoHat feed category (malware, phishing) really blocks. Blocked names are only looked up in DNS, never opened.

1. Open a shell: `aws ssm start-session --target <instance-id>`.
2. Put real feed names in `/etc/browser-test/blocked.txt` (format in the file; the shield's `client-test-results/<run>/domains.txt` works as is).
3. In `/etc/browser-test/env`, uncomment `BLOCKED_URLS`, `BLOCK_PAGE_IPS` (LeoHat's sinkhole address or addresses) and `MAX_BLOCK_FAILED=0`.
4. Run `sudo systemctl start browser-test.service` and check the S3 `summary.json` (`blocked.perCategory`).
