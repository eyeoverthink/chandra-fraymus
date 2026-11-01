# Secret-shaped files EXCLUDED from this folder (sync law)
Removed before push on 2026-11-01 (GitHub push protection + cadence scan caught them):
- hugging-face-api.txt (live HF user access token) — stays on OneDrive only; ROTATE it (huggingface.co/settings/tokens) since it sat in plaintext
- claude-comms-protocol.txt (contains a bearer-shaped string in the FRAYMUS V11 header block) — the protocol TEXT without secrets lives in opeg-protocol/*.html + GitHub comms-protocol repo
Law: values live on box/Base44/hub, never in git, never through chat. OneDrive = synced-to-cloud: do NOT keep plaintext secrets there.