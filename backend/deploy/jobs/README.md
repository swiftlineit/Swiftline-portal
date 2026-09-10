# Scheduled jobs

The portal has nine pieces of recurring maintenance work. Each is a standalone
script under `src/scripts/` that connects to MongoDB, does its work, and
disconnects- the shape an OS scheduler expects. Nothing inside the API runs
them, by design: a job that runs in the API process would stop when the API
stops and would run twice if the API were ever scaled to two instances.

This directory is what actually schedules them on the EC2 host.

| Job | Cadence | What stops working without it |
| --- | --- | --- |
| `job:credit:expire-reservations` | every 5 min | Abandoned bookings hold the client's credit for ever, so their available limit shrinks with every one |
| `job:email:drain` | every 5 min | Failed sends are never retried. First attempts still happen in-process, so this is the backoff ladder behind them |
| `job:flight:exceptions` | every 10 min | Flight delays, customs deadlines, manifest gaps, and connection risks are missed when nobody opens the flight page |
| `job:public-bookings:purge-expired` | hourly | Expired unpaid public drafts and their KYC uploads remain stored |
| `job:credit:mark-overdue` | hourly | Facilities live past their expiry date, statement status stays stale, utilisation warnings are never sent |
| `job:credit:close-billing` | daily 02:00 IST | No statement is ever issued, so no credit customer is ever billed |
| `job:claims:sweep-deadlines` | daily 02:30 IST | Clients are never warned their appeal window is closing; overdue reviews are never flagged |
| `job:credit:reconcile` | daily 03:00 IST | Balance drift between accounts and the ledger goes unnoticed until a customer reports it |
| `job:claims:purge-expired` | **not scheduled** | Nothing- see below |

Overdue *blocking* does not depend on any of these. The booking path recomputes
restrictions live from statement due dates, so an overdue client is refused
credit whether or not `mark-overdue` has run.

`job:claims:purge-expired` is deliberately left out of the schedule. It destroys
claim evidence past its eight-year retention, it needs `--apply` to do anything,
and nothing in the system is eight years old. Run it as a dry run, read the
output, get the retention policy signed off, and only then add it.

## Install

```bash
cd /var/www/Swiftline-portal/backend/deploy/jobs
sudo ./install.sh
```

Override the defaults if your layout differs:

```bash
sudo SWIFTLINE_APP_DIR=/opt/swiftline/backend SWIFTLINE_USER=ubuntu ./install.sh
```

It writes three files and starts nothing:

- `/etc/cron.d/swiftline-jobs`- the schedule
- `/etc/swiftline/jobs.env`- where the app and the Node binary live
- `/etc/logrotate.d/swiftline-jobs`- rotation, so the logs cannot fill the root volume

Re-running it is safe, and you should re-run it after any deploy that moves the
application directory or changes the Node version.

## Verify

Never trust a schedule you have not watched work once. Run a job by hand first-
`expire-reservations` is the safest, since with no stale reservations it does
nothing at all:

```bash
sudo -u ubuntu /var/www/Swiftline-portal/backend/deploy/jobs/run-job.sh job:credit:expire-reservations
tail /var/log/swiftline/job-credit-expire-reservations.log
```

You want to see `START`, the script's own summary line, then `OK finished in Ns`.

Then confirm cron itself picked the file up. Within five minutes of installing,
this should be non-empty:

```bash
tail -f /var/log/swiftline/job-email-drain.log
```

If it stays empty, check `journalctl -u crond` (Amazon Linux) or
`journalctl -u cron` (Ubuntu). The usual causes are a cron file that is
group-writable, or one missing its trailing newline- cron silently ignores both.

## Watch for failures

Every job appends to its own log. Failures additionally append one line to a
single shared file, so one command covers all of them:

```bash
tail -f /var/log/swiftline/failures.log
```

**Point an alert at that file before launch.** A cron nobody watches is only
marginally better than no cron: the whole failure mode this directory exists to
fix is work quietly not happening. `MAILTO` is deliberately empty in the cron
file, because cron mail needs a working local MTA and silently discards output
when there isn't one- which would recreate exactly that problem.

Until proper alerting is wired up, the honest minimum is a human checking
`failures.log` and the `close-billing` log daily.

## How the wrapper protects the jobs

`run-job.sh` exists because cron is a hostile environment for a Node app, and
each guard in it maps to a specific way these jobs fail without it:

- **PATH**- cron's PATH is roughly `/usr/bin:/bin`, so `node` and `npm` are
  usually not on it, especially under nvm. The install script records the real
  location in `jobs.env`.
- **Working directory**- the app reads `.env` through `dotenv/config`, which
  resolves relative to the working directory. cron starts in the user's home, so
  without the `cd` every job dies on a missing `MONGODB_URI`.
- **Overlap**- the two five-minute jobs would stack on a slow run and fight
  over the same rows. `flock` makes a run skip instead. Skipping is harmless:
  every job is idempotent and the next tick catches up.
- **Output**- cron discards stdout unless an MTA is configured, which is how a
  job that has been failing for a month goes unnoticed.

## Moving off cron later

The jobs themselves know nothing about cron. If this moves to ECS scheduled
tasks or a container platform, the schedule is the only thing that changes: each
job stays `npm run <script>` in the backend directory with `.env` present.
