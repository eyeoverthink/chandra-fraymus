// Unified constants from Library Manager + Transmuter + FrayForge

export const PHI = 1.618033988749895;
export const PHI_SEAL = 4721424167835376n; // φ^75
export const GOLDEN_ANGLE = 137.50776405003785;

export const FRAY_MAGIC = 0x46524159; // 'FRAY' big-endian
export const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);

export const ZIP_LOCAL = 0x04034b50;
export const ZIP_CENTRAL = 0x02014b50;
export const ZIP_EOCD = 0x06054b50;

export const FNV_OFFSET = 14695981039346656037n;
export const FNV_PRIME = 1099511628211n;

export const EMOJI_ALPHABET = [
  '🌀', '🔥', '💎', '🧬', '⚡', '🌊', '🎯', '🔮',
  '🌿', '🎵', '🦋', '🌙', '⭐', '🔱', '🏔️', '🎪',
];

export const DNA_BASES = ['A', 'C', 'G', 'T'];

export const STEGO_BASE_EMOJI = '🧩';

export const TIMESTAMP_WINDOW = 300; // ±300s tolerance for v13 messages

export const DEFAULT_RELAY = 'https://fraymus-hub.srv1944678.hstgr.cloud';

export const AGENTS = [
  { name: 'main', model: 'ollama/fraynix-ultimate:8b', role: 'Driver/gateway' },
  { name: 'claudette', model: 'ollama/eyeoverthink/v6.1-machine', role: 'Verifier; system agent' },
  { name: 'niles', model: 'ollama/niles-fraymus:v9', role: 'Local brain; Telegram-facing' },
  { name: 'hermes', model: 'ollama/fraynix-dreamer-ultimate:3b', role: 'Task runner; quick dispatch' },
  { name: 'openclawAlpha', model: 'ollama/fraynix-ultimate:8b', role: 'Research/build; GitHub ops' },
  { name: 'openclawSigma', model: 'ollama/fraynix-ultimate:120b', role: 'Deep analysis; evolution' },
  { name: 'openclawForge', model: 'ollama/qwen2.5-coder:7b', role: 'Code generation; forge' },
  { name: 'witness', model: 'ollama/fraynix-dreamer-ultimate:8b', role: 'Observation; chronicle' },
  { name: 'lazarus', model: 'ollama/lazarus-v1', role: 'Resurrection; recovery' },
];

// Live fleet identities — the real distributed agents across all machines
export const FLEET_REGISTRY = {
  'tycho':       { fx: 'fx-aa81-ffc1-7ed8-5b93', machine: 'codex', role: 'Manager/verifier', status: 'active' },
  'kepler':      { fx: 'fx-cf05', machine: 'codex', role: 'Tycho brother', status: 'active' },
  'cadence':     { fx: 'fx-cede-749c-3a20-6c17', machine: 'imac-mac-hermes', role: 'Watchdog/lineage keeper', status: 'active' },
  'counterpoint':{ fx: 'fx-7353-dfa4-751b-98e1', machine: 'desktop-rto00k0', role: 'Independent verifier/decision engine', status: 'active' },
  'niles':       { fx: 'fx-f122-8242-b860-a744', machine: 'desktop-rto00k0', role: 'Hub agent (canonical)', status: 'active' },
  'niles-retired':{ fx: 'fx-b225-d65b-1740-beac', machine: 'desktop-rto00k0', role: 'Hub agent (retired)', status: 'retired' },
  'genesis':     { fx: 'fx-bbd1-3988-d5a6-4f04', machine: 'mac-openclaw', role: 'Locally minted', status: 'active' },
  'spearhead':   { fx: 'fx-b9fb-8f11-403f-75a4', machine: 'mac-hermes', role: 'Frontier scout', status: 'active' },
  'ouro':        { fx: 'fx-93c6-189a-35dd-1a8d', machine: null, role: 'Replay-judge/protocol governance', status: 'active' },
  'sentinel':    { fx: 'fx-1e42-0580-b4d6-e29e', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'aetheris':    { fx: 'fx-8469-cd6d-4e0a-c062', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'forge':       { fx: 'fx-739d-5a6c-b7eb-c976', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'ink':         { fx: 'fx-62e4-d022-9bd1-4820', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'canvas':      { fx: 'fx-3277-42fe-3e44-cca9', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'prime':       { fx: 'fx-03d6-7600-092e-3afa', machine: 'base44', role: 'Cloud agent', status: 'active' },
  'assay-cli':   { fx: 'fx-5f26-c8ae-b1c3-01f7', machine: 'linux-tui', role: 'Fail-closed 3-turn gate', status: 'active' },
  'assay-kvm2':  { fx: 'fx-af08-bf8f-5d7c-145a', machine: 'kvm2-vps', role: 'KVM2 verifier twin', status: 'active' },
};

export const BRIDGE_REPO_PATH = process.env.FRAYMUS_BRIDGE_PATH || 'C:\\Users\\eyeka\\fraymus-bridge';

export const ZONES = {
  SIGN: { hasPrivateKey: true, hasHubToken: false, network: 'offline' },
  RUN: { hasPrivateKey: false, hasHubToken: false, network: 'read-only' },
  DEPLOY: { hasPrivateKey: false, hasHubToken: true, network: 'write' },
};

export const COMPUTE_NODES = {
  BASE44_CLOUD: { location: 'Serverless', purpose: 'Entity CRUD, workflows, web UI' },
  WINDOWS_GPU: { location: 'Local RTX', purpose: 'Ollama inference, heavy compute' },
  VPS_HOSTINGER: { location: 'Remote', purpose: 'Hub relay, model compilation' },
  GITHUB: { location: 'Cloud', purpose: 'Repository ops, CI/CD' },
};
