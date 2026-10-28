# Docker code execution

Chandra's configured runtime defaults to Docker for `code.run`. A missing engine,
missing image record, invalid configuration or failed isolation check disables code
execution. Normal model chat and other permitted tools remain available. There is
no automatic host fallback, image download, engine installation or credential lookup
from agent requests. Only the operator setup command below pulls images.

## This machine's current prerequisite

The current host was checked independently: WSL and VirtualMachinePlatform have
InstallState 1 (enabled), but `VirtualizationFirmwareEnabled:false` and
`HypervisorPresent:false`. Docker's Linux backend reports
`HCS_E_HYPERV_NOT_INSTALLED`. Containers cannot be live-validated in that state.

The user must enable CPU virtualization in firmware (Intel VT-x/Virtualization
Technology or AMD SVM/AMD-V, depending on the computer), save that setting, and
return after rebooting. This software does not change BIOS/UEFI settings or reboot
the computer. Enabling Windows optional features alone does not enable firmware
virtualization. After the firmware prerequisite is resolved, start Docker Desktop
in Linux-container mode and repeat setup/validation. If the machine is itself a VM,
its host must also expose nested virtualization.

The confirmed motherboard/CPU are ASUS PRIME Z390-A and Intel Core i9-9900K.
The [ASUS firmware guidance](https://www.asus.com/us/support/faq/1043786/) uses
Del/F2 to enter setup, F7 for Advanced Mode, then Advanced → CPU Configuration →
Intel (VMX) Virtualization Technology → Enabled, followed by F10 to save. The user
must perform and confirm those firmware/reboot steps; they have not been executed
by this implementation.

## Operator setup

From the Chandra directory, after the local Linux engine is ready:

```powershell
node server/sandbox/setup.js
```

This explicit command checks the engine is Linux and reports Docker's built-in
default seccomp profile, then pulls only:

- `docker.io/library/node:24-bookworm-slim`
- `docker.io/library/python:3.12-slim-bookworm`

Each pulled image must inspect as Linux, have an immutable `sha256:` image ID,
have an official Node/Python repository digest, and declare no `Config.Volumes`.
The command writes `DATA_DIR/sandbox-images.json` atomically, recording the immutable
IDs, source image references and repository digests. `DATA_DIR` defaults to Chandra's
`data/`; `CHANDRA_DATA_DIR` can explicitly choose another local data directory.
If any preflight, pull or inspection fails, an existing record remains unchanged.
Pulled image layers may remain in Docker after an unsuccessful setup.

Setup uses shell-free bounded Docker CLI calls, hidden process windows on Windows,
an isolated temporary Docker configuration directory with only an anonymous
Docker Hub auth entry (no credentials), and a reduced environment.
It pins the local Windows endpoint
`npipe:////./pipe/dockerDesktopLinuxEngine`, or `unix:///var/run/docker.sock` on
other platforms. Ambient `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_AUTH_CONFIG`,
existing registry logins and credential helpers are not used. It never saves
credentials. On Windows, the CLI defaults to Docker Desktop's standard installation
path; nonstandard installations need a deliberate trusted code/configuration change.
The Unix endpoint must actually host a local Linux engine; a remote TCP daemon
cannot be selected through this command.

Pulls are bounded to five minutes each, and engine/image probes to ten seconds
each, with 256-KiB captured-output bounds. The command does not accept custom image,
registry, endpoint, credential or execution-mode arguments. Runtime health and
execution do not call setup and use `--pull never`.

Restart Chandra after successful setup so it loads the new record. Check the
capabilities panel: configured Docker and verified availability are separate states.
Then run actual integration checks for container execution, host-file/network
denial, timeout, output limits and cleanup before treating the sandbox as verified.
Mock tests validate configuration and process contracts without executing Docker;
they do not prove this machine can run a container.

### Live verification after setup

Run the explicit operator harness after restarting the configured engine/app:

```powershell
node server/sandbox/verify.js
```

It forces Docker mode even if the application has an approved-host override. It
does not pull images. The JSON result is printed and saved as
`DATA_DIR/sandbox-verification.json` (under ignored `data/` by default). The CLI
exits nonzero for unavailable, skipped, failed or unverified execution. In
particular, `available:false,passed:false,skipped:true,tests:[]` means no container
tests ran; it is not a successful sandbox validation.

When ready, eleven sequential probes check Node/Python arithmetic, UID 65534,
NoNewPrivs, seccomp and effective capabilities, actual cgroup memory/pids/CPU
limits, read-only root, writable tmpfs plus reset in a fresh container, absent
Docker sockets/host mount roots, hard-IP connection denial, a four-second timeout,
cancellation after two seconds, and bounded output overflow. Each case retains
the actual execution/cleanup receipt. Cancellation before verified startup or
uncertain cleanup fails that case rather than inventing a pass. Markers exist
only inside ephemeral container tmpfs; no host probe files are mounted or deleted.

The live probes cannot pass on this host until the firmware virtualization
prerequisite above is resolved. Mocked harness tests validate reporting and
rejection paths; fixed probes are evidence of those observed boundaries, not a
general security certification.

## Isolation policy and limits

The Docker adapter verifies immutable local image IDs and the actual daemon-applied
container configuration before sending untrusted source code through stdin. Code
runs as UID/GID `65534:65534`, with a read-only root filesystem, no network, no host
mounts, dropped capabilities, no-new-privileges and Docker's default seccomp. The
only writable scratch space is a 16-MiB `noexec,nosuid,nodev` tmpfs at `/tmp`.
The runtime environment is cleared and rebuilt without host credentials.

Current adapter limits are 256 MiB memory (memory plus swap also 256 MiB), one CPU,
64 processes, at most 15 seconds per invocation and 32 KiB combined output. The
runtime also enforces its concurrency/queue limits and the agent's overall budgets.
Cancellation and deadlines remove the named container independently of the CLI.
Cleanup must be confirmed; uncertainty quarantines the executor. Agent code calls
also retain that uncertainty in their independent durable journal across restart.
Restart alone does not clear persisted quarantine. The offline
`npm run sandbox:reconcile -- --execution <UUID>` command can confirm only cleanup
for a historically witnessed exact container identity, without changing engine
resources or execution facts. Unwitnessed records remain blocked; see
[execution audit](execution-audit.md).
The precise current image IDs, limits, termination and cleanup
facts appear in health snapshots and durable execution receipts.

Docker isolation is an OS/container boundary, not a claim of immunity to kernel or
daemon vulnerabilities. Keep the engine and approved images maintained. A sandbox
without host mounts cannot directly edit workspace files: host file writes remain
separate, exact-approval actions. Arbitrary image IDs cannot be supplied by a model.
Operator setup pins current tags to immutable IDs; updating those IDs requires
running setup deliberately again and revalidating.

## Explicit approved host mode

Host mode requires **both** server environment settings:

```powershell
$env:FRAYMUS_CODE_EXECUTION = 'host'
$env:FRAYMUS_ALLOW_HOST_CODE = '1'
```

It retains the legacy exact-approval flow and runs with the host user's permissions,
without an OS sandbox. It is not selected automatically when Docker is unavailable.
Without both settings, host execution is rejected. Unsupported mode values leave
code execution unavailable rather than silently selecting an engine. To restore
the default, remove those overrides or set `FRAYMUS_CODE_EXECUTION=docker`, then
restart Chandra. These settings are server/operator choices, never model arguments.

## Image record format

The loader accepts the generated record's `images` map (or the legacy map alone):

```json
{
  "version": 1,
  "images": {
    "javascript": "sha256:<64 lowercase hex characters>",
    "python": "sha256:<64 lowercase hex characters>"
  },
  "sourceImages": {
    "javascript": "docker.io/library/node:24-bookworm-slim",
    "python": "docker.io/library/python:3.12-slim-bookworm"
  },
  "sourceRepoDigests": {
    "javascript": ["node@sha256:<64 lowercase hex characters>"],
    "python": ["python@sha256:<64 lowercase hex characters>"]
  }
}
```

Only immutable image IDs are consumed by runtime configuration. Stored command,
endpoint, credential or arbitrary flag fields are ignored. Files larger than
64 KiB and malformed/missing IDs fail closed. Source digests document the operator
pull; runtime health independently checks the installed images and policy.
