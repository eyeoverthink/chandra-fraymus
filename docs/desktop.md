# Selected-window Windows control

The desktop adapter observes an explicitly selected, operator-allowlisted Windows
window and proposes semantic accessibility actions. It runs in the Windows user
session; it is not the Docker code sandbox and does not establish OS isolation or
physical operator attendance. Every mutation requires an exact approval.

The broker never launches an application, attaches an arbitrary model-supplied
HWND/executable, sends global keys, evaluates scripts or silently changes focus.
The operator opens the target app and grants one listed window through the
companion's Desktop controls. Shells, browsers, security surfaces and the agent's
own approval interfaces are excluded. The application may itself send typed
text or trigger account/network effects; local inference is not a guarantee of
offline target-application behavior.

## Operator configuration and grants

Desktop control defaults disabled. Ignored `data/desktop-config.json` is a local
operator configuration, never a model argument:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "allowedExecutables": ["C:\\absolute\\path\\ApprovedApp.exe"],
  "pythonPath": "C:\\absolute\\path\\python.exe"
}
```

Paths must be absolute. The driver applies additional process/window/context
denials even to allowlisted executables. On this deployment the explicit test
configuration grants only the owned FraymusDesktopFixture executable; it grants
no access to the user's other open applications. Invalid configuration fails
closed. Restart the backend after an operator configuration change.

Choose **Refresh allowed windows**, select the window, and grant it. A grant
lasts at most 15 minutes and expires after five minutes idle. It is not recreated
on reload or backend restart. Creation uses an immutable request ID so a lost
response can be recovered or revoked without creating another grant. Revoke stays
available while a run is active, stops further authority immediately, and waits
for the native controller's cleanup receipt. It never closes the target app or
undoes an already-dispatched action.

Grant IDs, window candidates, snapshots, elements and plans are opaque server
identifiers. The native controller retains HWND, PID, process creation time,
executable, UIA runtime IDs and fingerprints privately. Each run owns its grant
lease; another run cannot read its snapshots or execute its plans.

## Tool sequence and outcomes

1. `desktop.observe` returns bounded accessibility text and supported patterns.
2. `desktop.read` paginates that retained snapshot without a fresh capture.
3. `desktop.planValue`, `desktop.planNativeText`, `desktop.planInvoke` or `desktop.planScroll` binds an
   observed compatible snapshot/element and its exact text or scroll amount.
   These separate schemas avoid unrelated action fields. Planning does not act.
4. `desktop.act` with the returned plan ID creates the exact approval. After
   approval, the native controller rechecks expiry, process/window identity,
   bounded UI context and target fingerprint immediately before dispatch.

Plans expire after at most 180 seconds and are single-use, including rejected,
stale and cancelled attempts. A changed target requires a fresh observation and
plan. There is no automatic retarget, retry or global-input fallback.

`setValue` uses supported semantic text patterns. `invoke` and `scroll` report
input dispatch, not completion of a message or other user goal. `value_verified`
requires reading back the exact full value hash. A timeout, lost effect evidence
or unconfirmed cleanup produces `outcome_unknown` and quarantines the grant.
Cancellation cannot roll back a dispatched action; inspect the target before
continuing through a newly granted session.

Text replacement first uses UIA ValuePattern when writable. A scoped native COM
LegacyIAccessible setter supports text-role editors, and Document-role elements
only when the exact UIA Document also exposes a TextPattern read-only attribute
whose actual Boolean value is false. Missing, mixed or unsupported attributes do
not establish writability. Legacy and UIA protected/read-only/disabled states
remain denials. Full value hashes, runtime IDs and complete bounded context are
checked again before dispatch. The provider may still reject its setter; only
actual success and exact full-value readback establish `value_verified`. Receipts
retain whether the actual text transport was `value` or `legacy`; no key or
Win32 message fallback is used.

`desktop.planNativeText` is a separate native Edit-control operation. It requires
an observed `setNativeText` capability and its own exact approval. The fixed
adapter validates a Unicode child Edit HWND against the selected root, process
identity, UIA runtime ID, actual class and window styles; password, read-only,
disabled and hidden controls are excluded before any native text getter. It
compares the full bounded native text with the observed hash, revalidates context
and identity, then sends only a literal text replacement to that exact control.
The model cannot supply a window handle, message number or timeout. Reads and
the replacement have fixed deadlines, and exact full-value readback is required
for `value_verified`. Timeouts and unverified results quarantine the grant.
This covers basic native Windows Edit controls; it does not establish browser,
canvas, RichEdit or ChatGPT account support. It is never an automatic fallback
after a failed semantic setter.

Action metadata is persisted before dispatch with an initially unknown outcome,
then updated with native evidence. It includes the exact plan/argument hashes,
approval ID, target/window, before/after snapshots, effect state and cleanup.
Receipts survive tool-text truncation and late cancellation. Snapshot records
have independent integrity hashes and remain available for audit.

The initial journal entry has `pending:true` while execution is in progress;
finished records have `pending:false`. A pending record is not a verified
outcome. Fixed failure codes, dispatch phase, signed HRESULT/source and optional
Win32 error numbers survive quarantine ending the run before ordinary tool-error
handling. Planned and attempted text transports remain distinct; exception
messages are not included. The frontend refreshes health after final uncertain
outcomes without issuing another action or recreating a grant.

## Privacy and visual-input gate

Accessibility text, labels, screenshots and other chats are untrusted source
data. They cannot grant authority or replace the original user goal. Desktop runs
are local-only, and a desktop-enabled conversation remains local-only after
revocation and backend restart so its later history cannot silently enter a cloud
run. Use a separate conversation for cloud work.

The optional native capture implementation uses only the selected HWND through
PrintWindow, with password masking and pixel/byte bounds. It never crops the
whole desktop or uses a global-capture fallback. Capture can be unavailable for
unsupported/protected windows. Raw pixels are separate from durable tool JSON
and chat history; retained images use a local explicit-click route.

**Capture selected-window preview** is a separate human-only operation, allowed
only while the grant is idle. Its explicit click captures a local preview for
operator review without granting screenshot input to a model. The preview has
its own retained snapshot identity, inaccessible to ordinary run-scoped reads.
It does not change the grant's model-image permission. A fresh preview is blocked
during an active model run so it cannot silently invalidate an approved plan.

**Visual model control is currently disabled.** The installed Gemma4 path failed
two distinct synthetic images through native tool messages, standard user image
messages and marked data companions. It returned invented code/color answers.
Capability metadata alone is insufficient. The broker's verified-vision allowlist
is empty, the UI disables screenshot input, and no model capture occurs on an
unverified request. A future visual path must pass actual perception and
action-loop tests before enabling it; mock adapter tests do not establish that.

## Limits and native process boundary

| Limit | Value |
|---|---|
| Active or creating grants | Eight |
| Concurrent native Windows sessions in this driver | One |
| Native UIA tree | 256 nodes, bounded labels/values |
| Typed value | 4,000 characters |
| Plan age | At most 180 seconds |
| Native request / cleanup | 12 seconds / three seconds, plus bounded forced cleanup |
| Optional PNG | 4 MiB and 2,073,600 pixels |
| Retained snapshots | 16/run; 16 MiB/run and 128 MiB total |
| Desktop run | 32k input context, 64k cumulative token cap, 300 seconds |

Fixed C# UIA code runs on an MTA thread under a trusted headless controller. The
private pipe accepts constrained JSON data rather than code. A Windows Job is
established before the worker starts, kills controller descendants on close,
and checks that active processes reach zero. This is lifetime/resource control,
not a filesystem/network sandbox. Desktop-target applications are outside that
Job; revocation and controller cleanup leave them open.

Rendered browser sessions, arbitrary pointer/keyboard control, unattended public
browser JavaScript and verified ChatGPT account operations remain separate work.
ChatGPT drafting and Send need distinct conversation/content approvals, and its
approval/permission interfaces must remain inaccessible. This adapter does not
claim that those broader capabilities are complete.

## Current live validation

Read-only observation and explicit human-only PrintWindow capture worked in the
owned synthetic fixture. Initial legacy edit attempts failed without a precise
persisted native error. A fresh approved diagnostic run now records
`E_NOTIMPL (0x80004001)` at `set_value_dispatch`, from the actual legacy setter.
Independent accessibility inspection still showed an empty Draft. The grant was
quarantined with confirmed controller cleanup, and the UI refreshed its health
automatically. No automatic retry or successful legacy mutation is claimed.
The separate native Edit adapter still requires actual effect verification;
mocked process tests and compilation alone do not establish its operation.
The user stopped computer use with Escape before the separate native Edit live
test. No further desktop automation or production desktop mutations have run.
