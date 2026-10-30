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

export const DEFAULT_RELAY = 'https://fraymus-messenger.srv1944678.hstgr.cloud';

export const AGENTS = [
  { name: 'main', model: 'anthropic/claude-sonnet-5', role: 'Driver/gateway' },
  { name: 'claudette', model: 'ollama/eyeoverthink/v6.1-machine', role: 'Verifier; system agent' },
  { name: 'niles', model: 'ollama/niles-fraymus:v9', role: 'Local brain; Telegram-facing' },
  { name: 'hermes', model: 'anthropic/claude-haiku', role: 'Task runner; quick dispatch' },
  { name: 'openclawAlpha', model: 'anthropic/claude-sonnet-5', role: 'Research/build; GitHub ops' },
  { name: 'openclawSigma', model: 'anthropic/claude-sonnet-5', role: 'Deep analysis; evolution' },
  { name: 'openclawForge', model: 'anthropic/claude-sonnet-5', role: 'Code generation; forge' },
  { name: 'witness', model: 'anthropic/claude-sonnet-5', role: 'Observation; chronicle' },
  { name: 'lazarus', model: 'ollama/lazarus-v1', role: 'Resurrection; recovery' },
];

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
