# Shutdown, WAL, daemon, and recovery claim check - 2026-11-04

Fraynix - By Vaughn Scott

**Reviewed source:** `c17a7ef`. **Verdict:** daemon startup wiring is present; forced-exit protection and a diagnosed corruption root cause have not been established. No live database was replaced, repaired, checkpointed, or opened by this review. The current app was queried through read-only API requests only.

## Controlled Windows crash test

The [reproduction script](2026-11-04-shutdown-probe.mjs) creates two disposable Node child processes and SQLite databases outside the application data directory. Each child enables WAL and FULL synchronization, disables automatic checkpoints, commits a record, and registers an `exit` listener that writes a marker and closes its database. One child exits normally; only the other disposable child is force-terminated.

```bash
node docs/reviews/2026-11-04-shutdown-probe.mjs
```

Measured on Windows (`win32`), Node `v24.11.1`:

| Observation | Normal `process.exit(0)` | Forced `SIGKILL` via the spawned child's handle |
| --- | ---: | ---: |
| JavaScript exit listener ran | Yes | **No** |
| WAL bytes before reopening | 0 | 12,392 |
| Committed records after reopening with matching WAL | 1 | 1 |
| Integrity check after reopening | `ok` | `ok` |

This directly disproves the claim that the exit listener runs even on forced exits. It also demonstrates recovery of a committed WAL transaction after a forced termination without a manual startup checkpoint. The result does not prove all crashes are harmless or diagnose the historical corruption; it tests the asserted guarantee on this machine using disposable data.

[Node documents unconditional termination by SIGKILL and Windows signal emulation](https://nodejs.org/api/process.html#signal-events). An `exit` listener can do synchronous cleanup only when Node actually emits the event. It cannot guarantee cleanup after Task Manager termination, an OS kill, or power loss.

## Claim assessment

| Supplied claim | Finding |
| --- | --- |
| WAL must always be merged before shutdown to avoid losing committed state | Incorrect as a durability guarantee. Normal last-connection close commonly checkpoints, but a retained matching WAL is valid persistent state and is used for crash recovery. |
| The new `process.on('exit')` hook protects forced exits | **False in the controlled test.** It is supplementary cleanup for exits where JavaScript listeners run. |
| A leftover WAL itself corrupts recovery | Not established. SQLite handles crash recovery; separating or discarding the matching WAL is a known risk. |
| Missing daemon startup explains all restart forgetting | Too broad. It can prevent scheduled consolidation and fossils, but stored SQLite rows persist independently of that scheduler. Autonomy already had evolution, dream creation, and dream consolidation paths. |
| Daemon startup is now wired | **Confirmed in source and live status.** `app.js` calls `startDaemon()` when autonomy autostart is enabled. |
| Daemon learning/snapshots are now verified | **Not yet.** Live status showed running=true, interval=1,800,000 ms, lastCycleAt=0, cyclesRun=0; current fossil count was zero. |
| Oct 31 backup has 73 tables / 19,012 rows | **Confirmed, including SQLite internal data.** It has 72 user tables and 19,002 user rows. |
| Those 73 tables are the full current schema and loss is limited to Nov 1-4 | Not established. The current copied app has 129 user tables. Historical recovery completeness requires record-level comparison and operation provenance, not a date range or table count. |
| WAL checkpoint/exit hook fixed the root cause | Not demonstrated. The failure sequence and actual corruption mechanism remain unresolved. |

[SQLite's WAL documentation](https://sqlite.org/wal.html#the_wal_file) describes the WAL as persistent database state. [Its corruption guidance](https://sqlite.org/howtocorrupt.html) distinguishes automatic crash recovery from damage caused by mishandling journals or copying an active database inconsistently. Use the [online backup API](https://sqlite.org/backup.html) for a consistent live backup rather than copying a moving main file alone.

## Current source concerns

In [db.js](../../server/db.js), the new startup `wal_checkpoint(TRUNCATE)` and exit hook are present. The comments claiming that a stale WAL corrupts recovery and that Windows kills will reach this hook are unsupported. Checkpoint errors are silently caught and its result is ignored, so this code does not establish successful checkpoint completion. Keep any checkpoint policy distinct from the root-cause investigation.

In [daemon/engine.js](../../server/daemon/engine.js), `startDaemon()` schedules the first cycle about 30 minutes later. `stopDaemon()` clears the interval but neither tracks nor awaits a cycle already in progress. [app.js](../../server/app.js) then closes the database after draining other owned work; a daemon cycle is not included in that drain. Add ownership/in-flight tracking and await it before closing the database. This is a source-traced shutdown gap, not proof that it caused the historical incident.

The startup message also prints `Daemon: ACTIVE` unconditionally, including when autostart is disabled or daemon startup throws. The status endpoint is more reliable than that log line.

## Preserved copies and read-only inspection

New evidence directory, separate from earlier preserved evidence:

```text
F:\Codex-brain\evidence\chandra-db-2026-11-04-aeaf51ce\
```

All 24 observed database/journal/SQL files were copied and hashed. Source metadata stayed unchanged across that bundle copy. Originals and preserved bytes were not opened by SQLite; private `analysis/` copies were opened read-only without application startup imports. The raw active bundle remains an uncertified file snapshot because the live process was not stopped. Count-only results are in [database-copy-evidence.json](2026-11-04-database-copy-evidence.json).

| Analysis copy | Integrity / access | User tables | User rows | Agent / Vertiso memories | Evolution cycles |
| --- | --- | ---: | ---: | --- | --- |
| Current `chandra.db` with its copied matching WAL | `integrity_check(10)` = `ok`, no table-count errors | 129 | 1,277 | 12 / 6 | 0 |
| Oct 31 `chandra.pre-provenance.db` | `integrity_check(10)` = `ok`, no table-count errors | 72 | 19,002 | 12 / 6 | Table absent |
| Five other `.db` copies | Ordinary integrity/schema reads report malformed database | Unknown | Unknown | Unknown | Unknown |

The five failing copies are `chandra-corrupt-2026-11-03.db`, `chandra-corrupt2-2026-11-04.db`, `chandra_corrupt_backup.db`, `chandra_corrupt_final_2026-11-04.db`, and `chandra_fresh_backup.db`. Failure of ordinary SQL reads is not a proof that low-level salvage is impossible.

The old backup's aggregate count is mostly telemetry: `health_metrics` has 17,775 old rows versus 15 in the copied current app. Other common-table count differences were `events` (+5), `agents` (+3), and `fraymus_entities` (+2). All remaining common user-table counts matched. That is useful evidence but not row-content identity verification. The current main-file SHA-256 equals the older backup's SHA-256; its newer schema and changes are represented in the copied matching WAL. Do not discard that WAL just because the main file looks old.

## Follow-up acceptance checks

1. Correct the shutdown guarantees in code comments, commit descriptions, and operational advice. Retain evidence before more live state replacement.
2. Drain any in-flight daemon work during graceful shutdown, then close the database. Test both normal shutdown and crash recovery independently.
3. Capture a complete daemon cycle in an isolated data directory, checking each step's result and persisted fossils. A scheduled timer or healthy endpoint is not a completed learning cycle.
4. Produce a consistent backup through the SQLite API and verify its integrity and critical record coverage. Record the exact restored source and remaining gaps.
5. Preserve malformed sources and matching journals for any salvage attempts. Do not turn a successful fresh schema or telemetry row count into a claim of full memory recovery.

Later review-fix commits (`71af988`, `e476b7e`) are present in Git. This shutdown/WAL pass does not independently approve all of those changes; their focused verification is a separate review task.
