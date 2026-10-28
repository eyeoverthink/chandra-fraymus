# Validation and remaining gates

Reference checks were rerun on Windows on October 27, 2026 before the coordinated
Chandra, MyAIPartner and fraymus-voice source update.

| Repository | Automated checks | Production build |
|---|---:|---|
| Chandra | 672 passed; no failures or skips | Passed |
| MyAIPartner | 179 passed | Passed |
| fraymus-voice | 43 passed | Python service; no frontend build |

From the Chandra directory, with the sibling repositories and dependencies set
up as described in the README:

```powershell
npm test
npm run build
npm --prefix ../MyAIPartner test
npm --prefix ../MyAIPartner run build
python -m unittest discover -s ../fraymus-voice/tests -p 'test_*.py'
```

These checks cover policy validation, exact approvals, durable run/effect
receipts, recovery, budgets, attachment limits, scheduling, source processing,
transport and interface contracts. Provider, Docker and desktop seams use
controlled transports. Native launcher tests use trusted owned child processes;
they do not establish arbitrary-code containment or a general desktop workflow.

Separate development observations exercised local model tool calls, uploaded
WAV transcription, PDF/ZIP reading and Windows OCR. OCR remains fallible: two
engines each read 27 of 28 small generated held-out cases exactly, with different
errors, and neither reliably recovered the original pixel-font examples. This
is not a general accuracy benchmark. Review extracted text against the source.

The Windows-native execution lab has completed fixed arithmetic inside normal
AppContainer after omitting one incompatible launch-policy attribute. It is not
an application execution mode. Strict LPAC identity verification, broader access
denial, broker restrictions, disk/registry bounds and hostile resource tests
remain open. See [execution audit](execution-audit.md).

Docker is the configured code sandbox. Live isolation remains unverified on the
reference setup, and execution fails closed until its prerequisites, pinned
images and live probes pass. It never silently falls back to host execution.
See [sandbox setup and probes](sandbox.md).

Cloud stays off by default. No paid model request was needed for this release
validation. Runtime databases, model files, recordings, local settings and
development experiment artifacts are excluded from these source commits.
