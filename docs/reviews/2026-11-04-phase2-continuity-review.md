# Phase 2 continuity review and hardening

Fraynix - By Vaughn Scott

**Outcome:** the Phase 2 boot path could roll back legitimate committed database state. This was reproduced only in disposable data directories, then fixed before adding another port. Remembered Vault verification and continuity verdicts were also hardened, and the system signing identity now persists across process restarts.

**Reviewed implementation:** `3167e38` (Remembered Vault and unified self-test), `5d7e21e` (state seek). **Fix author:** Codex, isolated branch `fraynix/phase2-continuity-hardening`, fast-forwarded into the shared branch after tests. **Independent review of these fixes:** still required from a different agent. This author does not independently approve their own patch.

Fix commits: `be2cbde` (continuity guards, receipt verification and regressions), `4e96c48` (durable signing identity), `a67ebd3` (private-key error redaction), `9a2ec22` (unperformed watchdog checks cannot pass). Tagged handoff: [`review/fraynix-phase2-continuity-2026-11-04`](https://github.com/eyeoverthink/chandra-fraymus/tree/review/fraynix-phase2-continuity-2026-11-04).

## Reproduced findings and resulting behavior

| ID | Before, on the reviewed Phase 2 source | Fixed behavior |
| --- | --- | --- |
| P2-01 [P1] Mutable state restored as an immutable file | A normal SQLite commit/checkpoint changed the main-file hash. State seek restored the older fossil behind the open connection and reported `HEALED_1_FILES`. **Two committed rows became one after reopen**, while `integrity_check` still returned `ok`. | SQLite databases, their journals and append-only JSONL/NDJSON logs are excluded from file-watchdog tracking/restoration. Legacy tracked entries are retained but skipped; direct heal calls also refuse them. Ordinary immutable-file healing still works. |
| P2-02 [P1] Failed checks marked passed | The unified self-test returned `ALL_CLEAR` with `first_entry_verified:false`, `integrity_chain:false`, and a failing writ subtest. Any callback that returned normally was treated as passing. | Round-trip, presence and integrity results are evaluated explicitly; governance `pass:false` propagates. An unperformed watchdog check cannot produce clearance. Healthy and deliberately failing fixtures are tested. |
| P2-03 [P2] Signature presence mistaken for authentication | Altering entry attribution and replacing its signature with zero bytes still produced `verified:true`. | Vault verification checks the signature over the signed body using the trusted public key. Missing/invalid required signatures and unavailable signer keys fail verification, with separate hash, signature and authentication fields. |
| P2-04 [P2] Exact feed bytes not preserved by verification | Untouched feeds ending in whitespace failed their own receipt hash because verification called `trimEnd()`. | Verification removes only the storage envelope's one final newline. Spaces, LF and CRLF belonging to the feed remain significant. |
| P2-05 [P2] Numbering stops at 9,999 | Four-digit discovery ignored entry 10000. Two feeds with the same title were assigned the same number/filename, overwriting the earlier value. | Numeric discovery supports four or more digits, sorting/read lookup stay unambiguous, and exclusive file creation prevents overwrite. Both entries 10000 and 10001 survive. |
| P2-06 [P2] Reference counted as a restored file | A JSON state-fossil reference incremented `restored` even though no file was written and the artifact remained missing. | Report `references_found` separately and keep `restored:0`; recovery remains unrecoverable without actual file content. |
| P2-07 [P2] Restart/storage continuity | The system identity was generated anew each start; the new vault default also used the working directory rather than configured `DATA_DIR`. | The vault uses configured data storage. The signing identity persists in `fraymus-identity.json` and a fresh-process test authenticates an earlier entry with the restored key. |

Writ self-tests also minted owner permission and wrote receipt rows in the application context. They now execute inside a rolled-back savepoint and restore the original owner slot, enablement and broadcast state. Receipt links use append order (`rowid`), preventing equal or backwards wall-clock readings from creating branches. Existing historical receipts are not rewritten or repaired.

This demonstrates a defect in the newly reviewed boot/recovery path. It **does not establish the cause of the earlier database-corruption incident**, recover previously lost records, or certify the completeness of old backups. In particular, an integrity check alone did not detect the demonstrated committed-row rollback.

## Evidence and tests

- [Before evidence](2026-11-04-phase2-continuity-evidence.json): source `5d7e21e`, guarded temporary child data directories, all worker operations completed; includes the 2-to-1 row loss and false `ALL_CLEAR` verdict.
- [Fixed evidence](2026-11-04-phase2-continuity-fixed-evidence.json): source `9a2ec22`, matching source hashes, 2-to-2 committed rows, forged signature rejected, exact whitespace verified, both high-numbered entries retained, and missing-file references no longer counted as restored.
- [Guarded reproduction](2026-11-04-phase2-continuity-probe.mjs): each DB-importing child validates its temporary sandbox token/path and receives its own `CHANDRA_DATA_DIR`. It never imports the application/server or opens the user's live database.
- [Regression suite](../../test/continuity-hardening.test.js): nine new contract tests, including legacy DB/log manifests, immutable healing, negative/positive self-tests, owner-slot preservation, receipt clock ties, forged/deleted signatures, numbering and fresh-process identity recovery.

```bash
node --test test/continuity-hardening.test.js test/ouroboros-inheritance.test.js
node docs/reviews/2026-11-04-phase2-continuity-probe.mjs --verify-fixed
```

**13 tests passed:** nine continuity tests and four existing inheritance tests. The implementation's original boot probe also passed **27/27** in a separate temporary data directory. Changed server files passed syntax checks. No frontend change was made. These are local validation results awaiting another agent's independent review.

The reproduction and evidence files were produced in this Codex session and committed separately as `568893e` while this handoff was being written. Shared Git author/co-author labels do not replace the session ownership and review status recorded here.

The original `state-seek-probe.mjs` directly imported DB-backed modules using the current environment's data directory. Its default command now forks a guarded temporary-data child before any such import. Its structure-only assertions had passed the data-losing implementation too, so they cannot establish recovery correctness.

## Runtime and machine handoff

The earlier immune closure commit `2c495b6` was already present on `origin/master`; its previously missing `review/fraynix-immune-round4-2026-11-04` tag has now been published. IMM-05 canary calibration remains deferred/advisory and is unaffected by this work.

The backend at `http://127.0.0.1:8787` was unreachable during the status check. No live database was restored, checkpointed, replaced or opened, and no backend was force-terminated or restarted. These source changes take effect on a normal backend start/restart; live API validation is not claimed.

Keep the configured `DATA_DIR` and its signing identity when moving machines. Git carries the code and this evidence, not the learned database state or private identity file. The new identity loader validates existing keys, never silently replaces an unreadable key, and avoids quoting key-file contents in error messages. Existing signed entries from the earlier ephemeral identity require their original trusted public key; they are not silently re-signed. Explicitly unsigned receipts remain hash-only with `authenticated:false`.

The boot manifest is a file inventory, **not a consistent SQLite backup**. Use SQLite's [online backup API](https://sqlite.org/backup.html) for a live database snapshot; coordinated restore is separate from immutable-file repair. Signature verification uses the standard [Node crypto API](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback), not a custom signature algorithm.

Next reviewer: inspect the mutable-file exclusions and legacy-manifest behavior first, rerun the negative and restart fixtures, then record an independent verdict here. State-fossil file restoration remains unimplemented rather than reported as successful. Further Phase 2 ports should build on this explicit baseline, with source versions and failure/restore tests recorded per subsystem.
