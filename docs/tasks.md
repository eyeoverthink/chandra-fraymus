# Local scheduled tasks

Open **Scheduled tasks** in the partner interface. Choose a local model, write a
fresh goal, select a schedule, set per-run and lifetime limits, then review the
preview before creating it. Existing chat history, attachments and desktop grants
are not copied. The app must remain running; it does not install an OS service,
wake a sleeping PC, send notifications elsewhere, or run while Windows is off.

Chat can also propose a task. `clock.now` reads the server clock; `tools.enable`
loads one schedule kind, such as `tasks-once`, before `tasks.createOnce` requests
approval. There are separate once, interval, daily and weekly create/update groups.
The smaller `tasks` group contains list/read and pause/resume/archive. Discovery
selects context, not authority. A guessed hidden name still faces the same policy.

## Time policy

| Schedule | Meaning |
|---|---|
| Once | One explicit ISO instant containing `Z` or a UTC offset |
| Interval | Elapsed UTC minutes anchored to the first explicit instant; 1–10,080 minutes |
| Daily | Local `HH:mm` in an explicit IANA time zone |
| Weekly | The same wall time on selected ISO weekdays: Monday 1 through Sunday 7 |

Creation requires a future instant, at least one second away, within five years.
Daily and weekly schedules use calendar dates rather than adding 24 hours. If a
wall time is skipped by daylight saving time, it moves forward by the gap. If it
occurs twice, only the first occurrence runs. The server uses the pinned Temporal
polyfill's compatible disambiguation policy. See [Temporal time zones](https://tc39.es/proposal-temporal/docs/timezone.html).

When an active recurring task has missed several slots because the app was offline
or busy, only its latest due slot is eligible. Older missed slots are not queued in
a burst. A missed once task can run once after startup. Resume explicitly selects
the next future slot at the time of approval; it does not replay paused dates.
An approved creation/update preview that no longer matches its first occurrence
fails and needs a fresh review.

## Authority, privacy and approvals

Task creation authorizes future **local** runs within the exact displayed limits.
It does not approve any tool effect in those runs. A later workspace write or web
request still needs its own exact approval. A pending approval puts the task into
attention and prevents future dispatch. After an approved one-off succeeds, it
becomes completed. A recurring task requires explicit resume after attention.

Scheduled runs cannot change tasks, create recursive schedules, acquire desktop
authority, use cloud inference, or use host code. Docker code remains possible
only through the separately configured sandbox and its normal availability checks.
Task titles, goals and receipts are private untrusted data. Reading or managing
them marks the receiving conversation local-only, including after restart. Cloud
callers are rejected before the read; queued inference and the post-input-count
cloud boundary recheck the durable privacy flag.

The local HTTP interface is intended for the same logged-in user and applies the
app's loopback/Host/Origin boundary. It is not a multi-user authorization service.
Direct task-panel mutations are explicit user actions; native chat mutations
additionally require a consumed approval bound to their exact arguments and full
untruncated preview. Large chat previews fail rather than hiding part of a task.

## Limits and durable execution

- At most 32 unarchived tasks and 256 task records; titles up to 120 characters,
  goals up to 20,000 characters, and the latest 20 occurrences per task returned.
- Lifetime limits: 1–1,000 runs and up to 1,000,000 tokens. Once tasks allow one run.
  A full per-run token allowance must fit before dispatch. USD allowance is zero.
- One scheduled occurrence at a time, and scheduling defers while any agent run is
  nonterminal. A user can still start interactive work after an occurrence begins.
- Run count and token reservations are persisted before dispatch. Actual usage
  increases monotonically, including reported overages; edits and resume do not
  reset counters. Failed, cancelled or uncertain work retains unresolved tokens
  conservatively. Local API dollars exclude hardware and electricity.

The ledger freezes the exact request, hash, task generation and due slot. Private
server provenance binds the run to that occurrence; public callers cannot supply
the reserved `task:` identities or forged provenance. Recovery attaches the exact
known run. It does not repeat interrupted or uncertain work under a fresh ID.

Every mutation has an idempotency key and revision check. If a creation response
is lost, recover its original key rather than creating another task. Canceling an
unresolved create records a durable tombstone even if the POST has not arrived.
If the task was already edited, cancellation conflicts instead of undoing newer
authority. Recovery responses include the task's current state.

Pause/archive cancel that task's owned run and stop future authority; already
dispatched effects cannot be rolled back. Shutdown stops claims first, waits for
pending starts and underlying callbacks, and closes SQLite only when they settle.
This does not prove rollback of target applications or cleanup after a forced OS
kill. The Windows stop script uses process termination; abrupt interruption is
recovered conservatively on restart.

The supported entrypoint acquires an exclusive OS IPC lock for the canonical
data directory **before** opening/migrating the database or recovering runs. A
second instance fails even with another HTTP port. The lock persists through
callback drain and is released by process exit. Windows named pipes and Linux
abstract sockets clear after crashes. Other Unix socket paths may need manual
cleanup after confirming their owner is gone; the app never steals them. This
is cooperative ownership in one OS IPC namespace, not a distributed lock or a
defense against malicious programs running as the same user. Do not share a
database across machines, containers or hard-linked aliases.

## HTTP contract

`GET /api/tasks` returns `{tasks, localOnly, requiresAppRunning}`. Task reads and
mutations otherwise return a flat Task with revision, generation, counters,
attention and history. `POST /api/tasks/preview` accepts a spec and returns its
canonical `spec`, `firstRunAt` and sample next occurrences. Creation adds
`requestId` and `expectedFirstRunAt` to that spec. Update additionally supplies
`expectedRevision`. Pause/resume/archive need `requestId` and `expectedRevision`.

`GET /api/task-requests/:id` recovers the mutation. Posting `{}` to
`/api/task-requests/:id/cancel` cancels an unresolved creation. Run history uses
the existing agent run/events endpoints, and each occurrence retains independent
approval and cancellation controls. Durable `task_receipt` events can arrive
after source-run cancellation without reviving that run.

## Validation limits

Controlled tests cover actual HTTP contracts, four-kind discovery at the default
input budget, separate creation/effect approvals, DST, offline coalescing,
concurrent receipts, budget reservations, privacy races, delayed callback drain,
and Windows cross-process ownership/crash release. Mock providers establish
runtime policy, not model reasoning quality. Live model evidence is retained
separately. UI rendering/build checks do not establish live scheduling UI behavior;
desktop automation remains stopped at the user's request.
