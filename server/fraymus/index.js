// FRAYMUS Master System — unified entry point
// All 5 Base44 apps consolidated into one importable package

// ═══ Layer 1: Core Cryptographic Primitives ═══
export * from './core/constants.js';
export {
  hex, unhex, toHex,
  sha256, sha256hex,
  sha256Sync, sha256HexSync,
  fnv1a, fnv1aStr,
  crc32,
  canonical,
  concat, bytesToBase64, base64ToBytes,
} from './core/crypto.js';

export {
  generateIdentity, numberFromPub,
  signText, verifyText,
  purePublicKey, pureSign, pureVerify,
  newPureIdentity, checkPureIdentity,
  selfTest,
} from './core/identity.js';

export {
  signMessage, verifyMessage,
  hubCanonical, hiveCanonical,
} from './core/signing.js';

// ═══ Layer 1: Multi-Format Encoding ═══
export { toEmoji, fromEmoji, encodeEmoji, decodeEmoji, stripEmoji } from './encoding/emoji.js';
export { encodeDna, decodeDna, gcPercent, dnaHypervector } from './encoding/dna.js';
export { wrapWasm, buildWasm, decodeWasm, decodeWasmFile, verifyWasm, transmute, genesisBlock0 } from './encoding/wasm.js';
export { frayHeader, parseFrayHeader } from './encoding/fray.js';
export { merkleRoot, merkle41, merkleDivergence } from './encoding/merkle.js';
export { zipStore } from './encoding/zip.js';
export { allForms } from './encoding/forms.js';

// ═══ Layer 2: Communication Protocol ═══
export {
  ENDPOINTS, sendCanonical, registerCanonical, inboxCanonical,
  isTimestampValid,
  kuramotoR, kuramotoStep, loraFreq,
} from './protocol/v13.js';

export { liveRegister, liveDirectory, liveSend, liveInbox, liveRetire } from './protocol/hub.js';
export { postSigned, verifyChain } from './protocol/mesh.js';
export { signThought, matrix, matrixDna } from './protocol/hive.js';
export { presenceStatus, presenceColor, isChainHealthy } from './protocol/presence.js';

// ═══ Layer 3: Intelligence & Evolution ═══
export { OuroborosEngine, falsificationTests, orbitalDistance, orbitalDecay, crossoverGenomes, mutateGenome } from './intelligence/ouroboros.js';
export { HermesFleet, SKILL_CATEGORIES, ALL_SKILLS } from './intelligence/hermes.js';
export { MotorDispatcher, JOB_STATES, selectNode } from './intelligence/motor.js';
export { OpenClawGateway, GATEWAY_ACTIONS } from './intelligence/openclaw.js';
export { ControlPlane } from './intelligence/control-plane.js';
export { NeedleQueue } from './intelligence/needle.js';
export { NILES_MODEL, FRAYVM_OPCODES, NILES_SYSTEM_PROMPT, buildModelfile, executeFrayvm } from './intelligence/niles.js';

// ═══ Layer 4: Bridge & Continuity ═══
export { OrificeBridge } from './bridge/orifice.js';
export { CrossTabMemory } from './bridge/cross-tab.js';

// ═══ Data Model ═══
export { SCHEMAS, ENTITY_NAMES, ENTITY_COUNT, getSchema, entitiesBySource } from './entities/schemas.js';
export { WORKFLOWS, WORKFLOW_NAMES, getWorkflow, scheduledWorkflows, eventTriggeredWorkflows } from './workflows/definitions.js';
export { MCP_TOOLS, TOOL_NAMES, getToolDefinition, listTools } from './mcp/tools.js';

// ═══ System Assembly ═══
export function createMasterSystem(entityStore = null, aiModel = null) {
  const ouroboros = new OuroborosEngine(entityStore, aiModel);
  const hermes = new HermesFleet();
  const motor = new MotorDispatcher(entityStore);
  const controlPlane = new ControlPlane(entityStore);
  const needle = new NeedleQueue(entityStore);
  const bridge = new OrificeBridge(entityStore);
  const gateway = new OpenClawGateway({ hermes, motor, ouroboros, controlPlane, bridge, entityStore });

  return { ouroboros, hermes, motor, controlPlane, needle, bridge, gateway };
}
