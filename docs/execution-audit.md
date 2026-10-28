# Independent sandbox lifecycle receipts

Docker execution now commits its own lifecycle journal before the engine is
invoked. Each record binds a server-generated execution ID, run/call ID, engine,
language and SHA-256 of exact arguments. It contains metadata only; source code
and captured output remain in their existing run/tool context rather than being
duplicated into this audit.

`code_receipt` events record settlement independently of the ordinary tool result.
If a run is cancelled while container cleanup is pending, the run stays cancelled
but the tracked operation still settles and publishes the later audit. Shutdown
must drain that callback before closing SQLite. The restart helper refuses to
stop an owned backend while prepared/dispatching code records remain pending.

The audit distinguishes committed dispatch intent, possible source submission,
verified isolation, termination/exit facts and confirmed cleanup. `finished`
means the lifecycle settled; it does not mean the program succeeded. A complete
audit with `unknown` outcome still has unconfirmed facts. The companion shows
these dimensions separately and retains raw JSON after cancellation/recovery.
It may refresh readiness by GET after settlement; it does not repeat code or
perform cleanup actions from the UI. Run polling ends at terminal source status.
Evidence arriving later is persisted and available through **Inspect receipts**;
it is not guaranteed to appear immediately without another history inspection.

Docker failures distinguish a never-created resource, a launched container whose
policy was rejected before source submission, and possible source execution.
Claimed cleanup requires exact removal plus verified absence. A running inspect
snapshot arriving after the CLI already exited cannot count as source execution:
if no input was submitted, the adapter rejects success even for exit code zero.

Unconfirmed cleanup quarantines further execution on that engine. The state
survives service restart. A failed receipt write or validation after dispatch also
blocks further work in the current process; the committed dispatch intent becomes
unknown during recovery. This prevents a transient persistence error from silently
re-enabling the engine. Source runs stop sibling effects without automatic retry.
Frozen independent snapshots prevent observers from changing the saved facts.

Recovery never invokes an engine or cleans a resource. Prepared work becomes
conclusively not started; dispatched work becomes unknown. Only missing latest
acknowledgement is retried. The original private ticket can settle late known
cleanup without reviving its source run. An unknown record cannot be turned into
a new execution ticket after restart. Merely restarting the backend does not clear
the persisted quarantine or establish cleanup. Cleanup-only operator reconciliation
is available for new records with a durable verified-running container witness,
as described below. Older or unwitnessed records remain blocked.

These lifecycle paths are validated with mock process/provider seams and real
SQLite reopen tests. This machine's Docker Linux engine is still unavailable
until firmware virtualization is enabled, so no live container isolation success
is claimed. See [Docker prerequisites and probes](sandbox.md).

## Cleanup-only operator reconciliation

New agent code calls bind a random execution-derived name, ownership label,
immutable image, local endpoint and daemon ID before the Docker CLI can launch.
After inspection proves the container is running with the complete required
policy, the adapter rechecks daemon identity and durably records its exact
64-character container ID before sending source through stdin. Failed or
asynchronous journal acknowledgements withhold source and still attempt cleanup.

For an unknown cleanup record whose source task is terminal, stop the owned app
and run from the Chandra directory:

```powershell
npm run sandbox:reconcile -- --execution <execution UUID from the receipt>
```

The command must obtain the same process-lifetime data-directory lock as the app.
It observes the pinned local engine only: two rounds check both witnessed ID and
expected name absent, with the same daemon ID before and after. It never creates,
starts, removes or stops containers. A surviving container/name, engine mismatch,
timeout, ambiguous error, active source, missing witness or concurrent journal
change refuses reconciliation. No reset API or model tool exposes this operation.

Conclusive absence updates only cleanup facts and appends a `code_receipt` history
event. Existing execution outcome, possible source execution, isolation, exit and
usage facts stay unchanged; in particular, `outcome: unknown` does not become
program success. `historyEventPublished: false` means the durable receipt needs
normal notification replay on next app startup. Inspect receipts after restarting
the app to see the latest audit. Each unresolved record independently blocks code.

This relies on the trusted CLI making one create attempt per execution with
`--pull never`, without replay. The inspected installed Windows client is Docker
29.5.3, build `d1c06ef`; its pinned source creates once and gates the extra
missing-image create behind the unused `missing` pull policy. The adapter now uses
the fixed Windows CLI path rather than PATH lookup. Revalidate this assumption
when replacing the trusted client. [Run source](https://github.com/docker/cli/blob/d1c06ef6b41d88d76866aea43c246cd7c63d04fa/cli/command/container/run.go)
and [create source](https://github.com/docker/cli/blob/d1c06ef6b41d88d76866aea43c246cd7c63d04fa/cli/command/container/create.go).

The local engine and endpoint must remain trustworthy and stable during checks.
Daemon-ID cloning, endpoint ABA retargeting, host administrators and storage
tampering are outside this observation contract. An unwitnessed delayed create
cannot be disproved from quick missing-object responses and stays quarantined.
Validation uses process seams and actual SQLite recovery/locking; live Docker
execution and recovery remain unverified on this firmware-disabled machine.

## Native Windows investigation

A separate fixed-payload AppContainer lab investigated a route without WSL. This
Windows 10 build exports the legacy AppContainer profile APIs but lacks the newer
PSEC process support required by the current Microsoft MXC support matrix.

Four negative attempts were retained. One child was created suspended and its
AppContainer flag, exact package SID, zero capabilities, low integrity, restricted
child policy, three-handle allowlist and Job memory/process bounds were checked
before resume. Node then exited with `0xC0000142` during DLL initialization, with
no arithmetic output. Attempts to create a separately named private window
station were denied; a system-generated create-only attempt reported an existing
object, which was not opened or modified. The exact DLL startup cause remains
unproved. Filesystem/network denial probes did not run.

All four owned profiles and their folders were deleted and confirmed absent; the
sole child exited, Jobs closed, and exact owned scratch cleanup was verified.
There were no GUI operations, model requests, production tasks, administrator
elevation or changes to existing desktop/window-station ACLs. The prototype is
not an available sandbox and is not selectable by the app. Docker remains the
configured default, with no automatic host fallback.

Primary references: [Microsoft AppContainer launch](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
[current MXC source](https://github.com/microsoft/mxc), and the retained native
lab receipts. Token setup alone does not establish a working execution boundary.

### QuickJS startup comparison

A second fixed trusted startup probe used the official QuickJS-ng v0.17.0
Windows x86-64 asset, pinned to SHA-256
`2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77`.
Its console executable has no direct USER32 import; that does not rule out
transitive dependencies or identify Node's earlier failure. The new launcher
binds the one-process, 256 MiB, kill-on-close Job atomically through
`PROC_THREAD_ATTRIBUTE_JOB_LIST` and verifies token, Job and child policy before
resume. Normal AppContainer setup succeeded, but QuickJS exited with
`0xC0000142` and no fixed arithmetic output. Child exit, Job active count zero,
stdio completion, profile deletion, absent profile folders and owned scratch
removal were confirmed.

One separate trusted host control repeated the exact runtime bytes, arithmetic
program, nonce input, memory/stack flags, reduced environment construction and
Job/handle/child restrictions without AppContainer. The executable and new
temporary paths differed. It also exited with `0xC0000142`, with empty output
and confirmed cleanup. Failure therefore also occurs outside AppContainer;
the specific DLL, shared launch policy, environment or execution context remains
unresolved. A stale `win32=122` in the generic control error is not the child
failure code. No model code was run on the host, and this diagnostic is not an
application execution mode or fallback.

One separately reviewed host trace added `DEBUG_ONLY_THIS_PROCESS` to the same
fixed control. Seven exact-child events were delivered and continued once:
process creation, ntdll/kernel32/KernelBase loads, KernelBase/kernel32 unloads,
then exit with `0xC0000142`. No exception or debug-string event was delivered.
The last mapped DLL does not establish the failing initialization operation;
debugging itself also changes loader behavior. Cleanup continued the exit event
before waiting on a duplicated process handle, confirmed its exit code, Job
active count zero and stream completion, closed all four image/DLL file-handle
occurrences plus caller-owned handles, and removed the exact empty scratch.
No new AppContainer profile or existing security setting was involved. Both
reviewed launcher/type hashes and the trace are retained with the evidence.

Source review also found that stock QuickJS registers `qjs:std`, `qjs:os` and
`qjs:bjson`, including bytecode deserialization and a Windows native DLL loader.
Omitting `--std` does not remove them. A restricted embedding would need to omit
these interfaces explicitly. Startup success, if obtained, would still require
LPAC token/canary checks, actual network and child-creation denial, filesystem
containment, resource/cancellation tests and cleanup evidence before untrusted
code. Normal AppContainer exposes AAP-readable resources and package storage;
Job limits provide no disk quota. Synchronous profile API deadlines remain
unimplemented. These experiments made no UI or existing-ACL changes and did not
enable a production sandbox.

Primary source: [pinned QuickJS-ng core and CLI](https://github.com/quickjs-ng/quickjs/tree/6d46d07d04041b40f4f49eaa7fdebe44c314c699),
[Microsoft process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

### Controlled child-policy comparison

Two later fixed trusted controls changed only the launch-policy attribute:
they omitted `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY`. Both the host and
normal AppContainer programs then returned the expected arithmetic `45` and
nonce with exit zero. Actual child-policy flags were zero before resume. Atomic
Job binding, 256 MiB memory, one-process limit, kill-on-close, no Job breakaway
and the three-handle allowlist remained verified. The AppContainer retained its
exact fresh SID, zero capabilities and Low integrity. Processes/Jobs/streams,
temporary profiles, both package paths and owned scratch cleanup were confirmed.
All earlier failures and pinned source versions remain retained.

This identifies a launch-policy compatibility effect for these observations,
not the internal Windows failure mechanism or a general sandbox success. Fresh
owned paths, profile identities and nonces differ between applicable attempts.
The native candidate is still not integrated or available to model code.

In particular, the Job limit is not universal process-launch prevention.
Microsoft documents that `Win32_Process.Create` children are not associated with
the originating Job. Direct and externally brokered process creation therefore
need separate restrictions and validation; no such broker launch was attempted.
Read/write confidentiality, LPAC, networking, disk/registry bounds, restricted
runtime construction and hostile-input/cancellation checks remain open gates.

[Microsoft Job association and broker caveat](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[active-process and breakaway limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).

A later AAP-opt-out request was stopped before resume or input delivery because
the strict Win32 token-class 46 query returned error 87. Its creation attribute
was requested, but no actual LPAC flag was proved and no fallback executed.
The native/driver enum's DWORD description does not establish the same complete
Win32 retrieval contract. An AAP-only access fixture could establish behavior
for that resource; it would not itself prove a general LPAC-state query.

That early stop retained its fresh profile because stdio workers had not started.
Separate cleanup-only reconciliation used the original terminal child/Job facts,
fresh process-absence witnesses, exact profile/SID/path/hash checks and a trusted
helper's observed exit to confirm profile/storage/scratch removal. The original
failure and `stdioDrained:false` receipt stayed unchanged. No startup was retried
and no native execution mode was enabled.

[Microsoft-hosted Win32 contract discussion](https://learn.microsoft.com/en-gb/answers/questions/6022970/supported-win32-method-to-verify-lpac-identity-bef).
