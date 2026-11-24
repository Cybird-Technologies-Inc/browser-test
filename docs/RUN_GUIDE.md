# Run guide: test a resolver and compare it with a public one

This guide gives the commands for a normal test run. Replace `<resolver-ip>` with the IP of the resolver under test and `<name>` with the label you want in the report. All options are in the [README](../README.md).

## Before you start

| Check | Why |
|-------|-----|
| Run from a network the resolver has approved | The resolver answers approved networks only. From any other network every lookup fails and the preflight stops the run with exit code 3 |
| Node.js installed and `npm ci` done once per clone | The runner needs the project dependencies |
| Keep the terminal open for the whole run | The run happens on this machine. Nothing runs in the cloud |

To see which public IP your machine uses, run `curl -s https://ifconfig.me`. Compare it with the IP that was approved. The preflight itself only checks that the resolver answers.

## 1. Setup (once per clone)

```bash
npm ci
```

## 2. Smoke test (about 2 minutes)

Run this first. It proves the approval works before you spend 20 minutes.

```bash
node run.js <resolver-ip> --compare 8.8.8.8 --duration 2m --rounds 1 --interval 30s
```

## 3. Standard run: DNS speed against a public resolver

Two rounds of 10 minutes with a 1 minute gap. It takes about 21 to 25 minutes.

```bash
node run.js <resolver-ip> --label "<name>" --compare 8.8.8.8 --compare-label "Google 8.8.8.8" \
  --duration 10m --rounds 2 --gap 1m
```

## 4. Run with the malware and phishing check

This adds the blocked-category check. The reference resolver is not given this check, because it does not carry your resolver's policy.

```bash
node run.js <resolver-ip> --label "<name>" --compare 8.8.8.8 --compare-label "Google 8.8.8.8" \
  --duration 10m --rounds 2 --gap 1m \
  --blocked-urls profiles/pool-blocked.txt --expect-blocked malware,phishing
```

| Option | Use |
|--------|-----|
| `--block-page-ips <ip1,ip2>` | Add this if the resolver answers blocked names with a sinkhole IP. Without it, only NXDOMAIN and empty answers count as blocked |
| `--start-at 14:30` | Wait until this local time (HH:MM) before starting |

The malware and phishing pool is small (5 malware names, 1 phishing name). Treat the result as a spot check.

## What to expect

| Event | What you see |
|-------|--------------|
| The resolver does not answer | A red ACTION NEEDED banner, exit code 3, and the same banner in `report.html`. Fix the approval first |
| A normal run | Exit code 0, even when a few lookups failed. Read the report |
| Output | `out/run-<timestamp>/report.html` and `results.json`. The `--out` folder must be new |
| Open the report | `xdg-open out/run-<timestamp>/report.html`, or from WSL `explorer.exe out\\run-<timestamp>\\report.html` |

The default run is DNS only. It does not load pages and does not run the load ramp.

## Reading the report

With `--compare`, the report opens with a **Resolver comparison** section: a summary sentence, a side-by-side table and the slowest names on each resolver. It gives facts, not a verdict. A gap of 20 ms or less in the median first-lookup P95 is called "about the same". One run from one network is one window: repeat it at another time before drawing a conclusion.

If the block check was not switched on, the report says so in a "Not checked in this run" line.
