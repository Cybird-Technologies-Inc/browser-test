# browser-test: AWS monitoring runner

This folder deploys ONE small EC2 instance that tests MANY ISP resolvers, one
after another. Every 15 minutes it runs `npm start` (the light profile) once per
**target** (one target = one ISP resolver). It measures page-load and DNS timings,
stores results in S3 and alerts by email. This setup is for testing, not production.

## How the many-ISP model works

- A target is a file `/etc/browser-test/targets/<label>.env` on the instance.
  The label is the file name (letters, digits, `-`, `_`; max 40). The file holds
  `RESOLVER_DNS_IP=<ipv4>` and, optionally, any app setting (see the example below).
- `/etc/browser-test/env` is the shared base (profile, `OUT_DIR`, browser path).
  The target file is applied on top of it. The label always comes from the file name:
  a `RESOLVER_LABEL` line in the base file is ignored.
- `run-all.sh` loops over the targets in sorted order. For each one it switches the
  host resolver (this also clears the cache, so ISPs do not share answers), runs
  `npm start` as the unprivileged user with a timeout (default 20 minutes,
  `TARGET_TIMEOUT`), uploads the results, sends the heartbeat metric (exit 0 or 1) and
  sends an alert for any non-zero exit. One failing target never stops the others.
- Alerts name the label. Exit codes: 1 threshold exceeded, 2 config error,
  124 timeout, 125 resolver switch failed, other = crash.
- Each target has its own heartbeat alarm `browser-test-heartbeat-<label>`.
- **All ISPs must approve the same Elastic IP.** There is one instance and one IP.

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
| Elastic IP | `browser-test` | Fixed source IP for the resolver's approved networks |
| CloudWatch alarm, one per target | `browser-test-heartbeat-<label>` | Fires when no run of that target completed for 45 minutes |

On the instance:

| Item | Where |
|------|-------|
| App releases | `/opt/browser-test/<sha>`, symlink `/opt/browser-test/current` |
| Shared settings (edit here) | `/etc/browser-test/env` |
| Targets, one file per ISP | `/etc/browser-test/targets/<label>.env` |
| Run output | `/var/lib/browser-test/out/<label>/` |
| Timer and units | `browser-test.timer`, `browser-test.service`, `browser-test-alert.service` |

## Cost

About 15 USD per month, mostly the `t3.small` instance (about 15 USD in
`ap-south-1` at on-demand price). The 20 GB disk, the Elastic IP in use, S3
and CloudWatch add a few cents to about one USD. Check the current AWS prices.

## Prerequisites

- AWS CLI v2 and a profile that can create the resources above. Default profile: `Cybird-Dev`.
- `git`, run from a checkout of this repo.
- The `deploy/` folder must be **committed**: the release is built with `git archive HEAD`.
- An email address for alerts, the IPv4 address of the first resolver under test, and a VPC and public subnet.

## Environment variables

| Variable | Needed by | Default | Meaning |
|----------|-----------|---------|---------|
| `ALERT_EMAIL` | install | none, required | Alert recipient. Never written to the repo |
| `RESOLVER_DNS_IP` | install | none, required | resolver under test IPv4. Never written to the repo |
| `VPC_ID` | install | none, required | VPC to launch in. No default VPC is assumed |
| `SUBNET_ID` | install | none, required | Public subnet of `VPC_ID` (route to an internet gateway) |
| `AWS_PROFILE` | all | `Cybird-Dev` | AWS CLI profile |
| `AWS_REGION` | all | `ap-south-1` | Region |
| `INSTANCE_TYPE` | install | `t3.small` | Instance size |
| `RESOLVER_LABEL` | install, update | (none, required) | Metric dimension for the heartbeat. Keep equal to the label in `/etc/browser-test/env` |
| `ALLOW_DIRTY` | install, update | unset | `1` deploys HEAD even if tracked files have uncommitted changes (they are not included) |
| `DRY_RUN` | all | unset | `1` prints every action and calls no `aws` command. The account id shows as `000000000000` |
| `YES` | uninstall | unset | `1` skips the typed confirmation |
| `PURGE_BUCKET` | uninstall | unset | `1` also empties and deletes the results bucket |

## Install

1. Log in: `aws sso login --profile Cybird-Dev` (or your usual method).
2. Commit your changes so `HEAD` holds the release you want.
3. Preview, with no AWS calls:

   ```bash
   export ALERT_EMAIL=<your address> RESOLVER_DNS_IP=<resolver ip> VPC_ID=<vpc> SUBNET_ID=<public subnet>
   DRY_RUN=1 deploy/aws/install.sh
   ```

4. Install for real: `deploy/aws/install.sh`
5. **Confirm the SNS email.** AWS sends a mail to `ALERT_EMAIL`. Click
   "Confirm subscription". Without this click no alert is delivered.
6. **Ask each ISP to approve the Elastic IP.** The script prints the IP at the end.
   A resolver may answer only approved networks, so its runs fail until this is done.
7. Wait 5 to 10 minutes for the first boot. `RESOLVER_LABEL` and `RESOLVER_DNS_IP`
   from the install become the first target.

Install also deletes the legacy alarm `browser-test-heartbeat-missing`, if present.

## Add or remove an ISP target

```bash
DRY_RUN=1 deploy/aws/add-target.sh <label> <resolver-ipv4>   # preview, no aws call
deploy/aws/add-target.sh <label> <resolver-ipv4>             # RUN_NOW=1 also starts a run
deploy/aws/remove-target.sh <label>                          # asks to confirm; YES=1 skips
```

`add-target.sh` writes the target file through SSM (it refuses to overwrite an
existing file unless `FORCE=1`) and creates the alarm. Then ask that ISP to approve
the Elastic IP. `remove-target.sh` deletes the file and the alarm; S3 results stay.

Per-target overrides: open a shell and add `KEY=value` lines to the target file.

```bash
aws ssm start-session --target <instance-id>
sudo nano /etc/browser-test/targets/<label>.env
```

```
RESOLVER_DNS_IP=<ipv4>
BLOCKED_URLS=/etc/browser-test/blocked.txt
BLOCK_PAGE_IPS=<this ISP's sinkhole IPv4,IPv6>
MAX_BLOCK_FAILED=0
MAX_P95_DNS_MS=250
```

### Timing

Cycle time is roughly 1 to 3 minutes per target. Total = sum over all targets, and it
must stay below the 15-minute timer interval. A cycle that is still running makes the
next tick skip (a lock prevents overlap), which shows as a heartbeat gap. Beyond about
5 targets, raise the interval (edit `browser-test.timer`) or split targets over several runners.

## First-run check

```bash
aws ssm start-session --target <instance-id> --profile Cybird-Dev --region ap-south-1
sudo tail -n 50 /var/log/browser-test-userdata.log   # setup finished?
sudo systemctl start browser-test.service            # run once now
sudo journalctl -u browser-test -n 50 --no-pager
sudo resolvectl status                               # resolver-under-test global, VPC resolver for amazonaws.com only
```

Then check that `s3://<bucket>/results/resolver=<label>/latest.json` exists.
After the first completed run the heartbeat alarm turns to OK.

## Update

Commit, then run `deploy/aws/update.sh`. It uploads the new release and runs
`setup.sh` on the instance through SSM. `/etc/browser-test/env` and the target files are kept.

### Migration from the single-target version

Run `deploy/aws/update.sh`. If `/etc/browser-test/targets/` has no `*.env` file, `setup.sh`
builds one target from the old files (`resolver-label` and `resolver-dns`, or `leohat-dns`),
so monitoring continues. Old alarm: run `deploy/aws/install.sh` once more (same
`RESOLVER_LABEL`, `RESOLVER_DNS_IP`, `VPC_ID`, `SUBNET_ID`) to create the per-label alarm and delete
`browser-test-heartbeat-missing`. A stale `RESOLVER_LABEL` line in the old env file is ignored.

## Change the profile or thresholds

`/etc/browser-test/env` is the shared base for all targets. It is written once from
`profiles/light.env` and never overwritten, so your edits survive updates. For one ISP
only, edit its target file instead (see above).

```bash
aws ssm start-session --target <instance-id> --profile Cybird-Dev
sudo nano /etc/browser-test/env   # for example MAX_P95_DNS_MS=300
```

The next timer run reads the files. Do not change `OUT_DIR` in the base file.

## Heavy profile: on demand only

Do **not** run `heavy-start.env` or `heavy.env` against a live ISP resolver without the
owner's agreement. An ISP resolver serves real subscribers. The light `t3.small` is too
small for them. If agreed, use a separate, larger, temporary instance, run the
profile by hand from a shell (never from the timer), and delete the instance after.

## Rollback and uninstall

```bash
DRY_RUN=1 deploy/aws/uninstall.sh   # preview
deploy/aws/uninstall.sh             # lists what it found, asks you to type a confirmation
```

It deletes only resources with the exact names and tags above, including every alarm named `browser-test-heartbeat-*`. The results
bucket is kept unless `PURGE_BUCKET=1`. To roll back a bad release only, check out
the previous commit and run `deploy/aws/update.sh`.

## Security notes

- The instance has no inbound rules and no key pair. Shell access is through SSM Session Manager.
- IMDSv2 is required with hop limit 1. The root disk is encrypted.
- The instance role can only: put objects under `results/`, get objects under
  `releases/`, publish to the one SNS topic, and put metrics in the `BrowserTest`
  namespace (the one action that cannot be limited by resource).
- The bucket blocks all public access and uses SSE-S3.
- `browser-test.service` runs as root only to switch the host resolver between targets. `npm start` and Chromium run as the unprivileged user `browsertest` (dropped with `setpriv`). The unit keeps `NoNewPrivileges`, `ProtectSystem=strict` and a short `ReadWritePaths` list.
- To keep the Chromium sandbox working on Ubuntu 24.04, `setup.sh` installs a small AppArmor profile
  that allows user namespaces for the Playwright browser binaries only. The host-wide restriction stays on,
  and the app never runs with `--no-sandbox`.
- `RESOLVER_DNS_IP` is in the instance user-data (readable by principals with `ec2:DescribeInstanceAttribute`) and in a root-only file. It is not a secret, but it is not public.
- DNS has no fallback on purpose. If the resolver is down, runs fail and alert, instead of silently measuring a public resolver. AWS endpoints use the VPC resolver so alerts and uploads still work.
- Node is pinned and checked against `SHASUMS256.txt` from the same release.
  This detects corruption, not a compromised nodejs.org.

## Known limits

- One instance, one Elastic IP shared by all ISPs. If it dies, there are no runs until you re-run `install.sh`; the heartbeat alarm tells you.
- The resolver stays set to the last target after a cycle. Targets are tested one at a time, never in parallel.
- The heartbeat alarm covers a dead timer or instance. It does not detect a run that exits 0 with useless data.
- `t3.small` is enough for the light profile only.
- If the AWS-side DNS bypass or the resolver link fails to apply, check `resolvectl status` first.
- The scripts were written without a live AWS test. Run `DRY_RUN=1` first, and watch the first install.

## Turn on the feed-category check

The runner can check that each the resolver feed category (malware, phishing) really blocks. Blocked names are only looked up in DNS, never opened.

1. Open a shell: `aws ssm start-session --target <instance-id>`.
2. Put real feed names in `/etc/browser-test/blocked.txt` (format in the file; the shield's `client-test-results/<run>/domains.txt` works as is).
3. In the target file of the ISP (or `/etc/browser-test/env` for all), set `BLOCKED_URLS`, `BLOCK_PAGE_IPS` (the resolver's sinkhole address or addresses) and `MAX_BLOCK_FAILED=0`.
4. Run `sudo systemctl start browser-test.service` and check the S3 `summary.json` (`blocked.perCategory`).
