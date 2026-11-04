# Database incident review - 2026-11-03

Fraynix - By Vaughn Scott

**Status: preservation complete; recovery and cause remain unresolved. No database was restored, deleted, replaced, checkpointed, or opened in place by this review.**

The user supplied another agent's account proposing WAL deletion and starting a fresh database. This review checks that account against current source, SQLite documentation, and preserved local files. Git source at inspection was `2ca1b01`; Content Nexus source changes were still uncommitted. This report does not approve those changes or the recovery actions described in the supplied account.

## Immediate handoff to the implementation agent

Pause further database reset, deletion, or replacement. Preserve each database with its correctly named associated journals. Do not label runtime memories, learned patterns, generation history, and entity records as automatically regenerable. They are separate from source code. Coordinate a recovery owner and work on fresh analysis copies; do not write into the preserved evidence. Continue source development against a separate data directory if needed rather than modifying recovery inputs.

## Preserved evidence

Local evidence directory:

```text
F:\Codex-brain\evidence\chandra-db-2026-11-03-3d00b5aa\
```

- `manifest.json`: ten files copied, with SHA-256, sizes, source timestamps, and before/after metadata stability.
- `read-only-analysis.json`: integrity and table-count results from private analysis copies.
- `analysis/`: copies used by SQLite; the preserved files above that directory were not opened by SQLite.

The raw databases and any user records stay outside Git. The count-only analysis is also attached to this review as [database-incident-evidence.json](2026-11-03-database-incident-evidence.json). Copy the evidence directory separately for another machine; it is not part of a Git clone.

Capture occurred at `2026-11-04T03:16:16Z` (November 3, 2026, about 7:16 PM America/Los_Angeles). All ten copied files had unchanged size and modification time across their individual copy operations. No process was stopped, so these are preserved bytes as found, not a guaranteed transactional snapshot across an active writer.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| Current `chandra.db` | 1,138,688 | `0b0c83665c53d5923aa174a7bd8e056bc2ea327101bebd68c7a4113d4da6a3fd` |
| `chandra_corrupt_backup.db` | 15,675,392 | `83d2b1de39492bc54d82610af14da2c643a1019afa5aba24bce8cd37f32f6a47` |
| Older `chandra.pre-provenance.db` | 2,703,360 | `7074f6ba391aa7ba6b10e81d544e93d7f63122d980e4440b0e376613015d5c0a` |

The preserved `chandra_backup.db-wal` and `chandra_main_only.db-wal` files were empty; corresponding `.db` files were not present in the inspected directory. Do not pair them with a differently named database. The 50-byte `chandra_recovered.sql` file was preserved, but its presence is not evidence of a successful data recovery. The original pre-reset WAL was not identified in this inspection.

## Findings from read-only analysis copies

SQLite version reported by the local `better-sqlite3` library was `3.53.2`. Connections were read-only with `query_only` enabled. No application migrations or startup code were imported.

| Check | Current `chandra.db` copy | Older `chandra.pre-provenance.db` copy |
| --- | ---: | ---: |
| `PRAGMA integrity_check(20)` | `ok` | `ok` |
| User tables enumerated | 104 | 72 |
| `agent_memories` | 0 | 12 |
| `vertiso_memories` | 0 | 6 |
| `bus_messages` | 0 | 29 |
| `forged_agents` | 0 | 7 |
| `synthesized_workflows` | 0 | 2 |
| `fraymus_entities` | 0 | 780 |
| `ouroboros_cycles` / `ouroboros_genome` / `ouroboros_workspaces` | 0 each | Tables absent |
| `perspective_sessions` / `perspective_playbook` | 0 each | Tables absent |

The 15.7 MB corrupt backup could not be opened normally: SQLite reported `database disk image is malformed`. That proves ordinary access failed for this copy, not that every record is irrecoverable. A usable older snapshot exists, but it predates the newer tables and cannot establish completeness for recent history.

## Corrections to the supplied recovery rationale

1. **WAL is not only uncommitted work.** SQLite can commit into the WAL before checkpointing the main file; separating the files can lose committed transactions or cause corruption. Deleting the WAL is not a general safe recovery step. [SQLite WAL documentation](https://sqlite.org/wal.html#the_wal_file)
2. **A force kill alone does not establish the corruption cause.** SQLite is designed to recover after application crashes. Journal removal, mismatched copies, storage faults, or other causes require evidence before attribution. [SQLite corruption documentation](https://sqlite.org/howtocorrupt.html)
3. **Migrations recreate schema, not history.** [db-migrate.js](../../server/db-migrate.js) creates tables; it does not reconstruct deleted memory rows, genomes, playbooks, bus history, or entity records. The before/after evidence above shows why a healthy fresh schema is not restored continuity.
4. **The application lock is not crash recovery.** [data-lock.js](../../server/data-lock.js) coordinates cooperating processes through an IPC endpoint derived from the data directory. It is separate from SQLite transaction durability. [db.js](../../server/db.js) configures WAL and `synchronous = FULL`; neither source setting proves the actual cause of this incident.
5. **The variable correction is distinct and plausible.** Current uncommitted [runtime.js](../../server/runtime.js) passes `ollamaUrl` into `createContentNexus()`; that matches the existing parameter name. The `extraTools` limit of 500 is committed in `2ca1b01`. Neither source correction recovers database state or resolves the open Cross-Tab findings.

## Recovery sequence for the owner

1. Preserve the remaining original evidence and identify all earlier backups and any matching pre-reset WAL/journal. Record exact commands and file movements from the incident before claiming a cause.
2. Work from new copies of the evidence. Use SQLite's recovery tooling for the malformed file if available, without writing recovered output back into it. The `sqlite3` CLI was not found on PATH during this inspection. [SQLite recovery documentation](https://sqlite.org/recovery.html)
3. Build a separate recovery candidate and compare table counts, schema compatibility, and record identities against the new current database and the healthy older snapshot. Treat salvaged rows as candidates, not automatically verified truth; SQLite recovery can resurrect deleted data or alter values.
4. Validate the candidate with integrity, foreign-key, and application-level checks in an isolated data directory. Preserve keys, overrides, and other continuity files separately. Do not simply swap an old database into a concurrently running app.
5. Present the recovered coverage, known gaps, target path, and rollback plan to Vaughn before replacing the active database. This review authorizes no promotion. Keep both original and fresh-runtime evidence until the result is accepted.
6. Add a supported backup/restore workflow and startup diagnostics after the incident is contained. A healthy `/api/health` or recreated schema is not a recovery acceptance test.

## Owner response

### Follow-up acknowledgement relayed by Vaughn

Vaughn supplied a follow-up in which the implementation agent acknowledges creating the fresh database after moving the malformed one, retracts the "all regenerable" description, reports that its attempted WAL rename cannot now be accounted for, and says it has paused database operations. This is a user-relayed acknowledgement, not a verified command-by-command reconstruction. No recovery owner has yet claimed the row below in the repository.

The acknowledgement is useful, but these points remain open:

- **Cause:** the statement that `taskkill /F` caused the corruption is not established by the evidence. SQLite normally recovers from process crashes. Preserve the operation sequence and examine journal handling and other possible causes before assigning one.
- **Missing WAL:** the reported 4.1 MB size and its contents were not measured in this review. A WAL may contain committed data, but its byte size does not tell us how many distinct records were lost, which frames had checkpointed, or whether every transaction was committed. The correctly named original WAL is missing from the directory examined; that is not proof that no other copy exists anywhere.
- **Shutdown:** [data-lock.js](../../server/data-lock.js) is an ownership lock, not a graceful-shutdown controller. The `SIGINT`/`SIGTERM` handlers and `stop()` path in [app.js](../../server/app.js) drain owned work and close the database. Use the owning console or service's supported graceful stop, rather than treating lock release as database recovery.
- **Source versus runtime:** Content Nexus is committed in `b0e7bda`. Its source is preserved in Git, but [content-nexus.js](../../server/intelligence/content-nexus.js) creates tables and queries saved browsing, trend, and outlier data. The implementation therefore depends on a compatible database and its contents to deliver those features.

Additional verification performed after the acknowledgement:

```bash
node --check server/intelligence/content-nexus.js
node --check server/intelligence/content-nexus-routes.js
node --check server/runtime.js
npm run build
```

All four commands passed. The frontend build reported a bundle-size warning; no runtime database was opened by these checks. These results establish server syntax and frontend compilation, not Content Nexus query correctness, end-to-end functionality, or recovered history. All ten preserved evidence files were rehashed and still matched the original manifest. The recovery CLI remains unavailable on PATH; no tool was installed and no recovery attempt or live replacement was performed by this follow-up.

| Owner/session | Recovery candidate | Integrity + row-level evidence | Known unrecovered data | Approved promotion |
| --- | --- | --- | --- | --- |
| Unassigned | Pending | Preserved copies examined as above | Recent pre-reset state unknown | None |

Append replies here and update the README review queue. Do not rewrite the captured evidence or describe this review as a completed restore.
