import { verifyHiveChain } from '../intelligence/hive-bridge.js';
import { recallMemories, storeMemory } from './agent-memory.js';

const RE_AGENT_ID = 're-analyst';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

// ─── 18 upstream build gates from BUILD-GATES.md ─────────────────
// Documented lessons from the upstream RE toolchain (darwin-arm64).
// Stored at confidence 0.9 — not reproduced on this Windows machine.
// Confidence upgraded to 1.0 only when independently reproduced locally.

const BUILD_GATES = [
  { gate: 1, keyword: 'JDK', title: 'JDK 25 required for Ghidra 12.3 DEV', fix: 'Install JDK 25 EA (Temurin or Oracle). Ghidra 12.3 DEV will not start on JDK 17 or 21 — the analyzeHeadless script checks JAVA_HOME version and exits with "Unsupported JDK" if < 25.' },
  { gate: 2, keyword: 'JAVA_HOME', title: 'JAVA_HOME must point to JDK 25 installation', fix: 'Export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home before running Ghidra. Shell profiles may override — verify with `java -version` in the same shell.' },
  { gate: 3, keyword: 'Ghidra', title: 'Ghidra headless analyzer timeout per function', fix: 'Set GhidraScript timeout to 90 seconds per function via -scriptTimeout 90. Without this, complex functions (switch tables, deeply nested loops) hang the pipeline indefinitely.' },
  { gate: 4, keyword: 'dylib', title: 'radare2 dylib linking fails on ARM macOS', fix: 'Build radare2 from source with `sys/install.sh` instead of Homebrew. The Homebrew bottle links against x86_64 dylibs on some mixed-arch systems. Verify with `file $(which r2)` showing arm64.' },
  { gate: 5, keyword: 'rabin2', title: 'rabin2 -i import count mismatch with Ghidra', fix: 'rabin2 -i counts PLT stub entries (92 for /bin/ls). Ghidra counts unique import symbols (78). Use rabin2 for triage speed and Ghidra for accuracy — the 14-entry gap is PLT aliases and versioned symbols.' },
  { gate: 6, keyword: 'clang', title: 'clang -fsyntax-only needs stub headers for decompiled C', fix: 'Decompiled C references Ghidra-generated types (undefined4, byte, etc.). Create a ghidra_types.h stub with typedefs before running clang. Without it, every function fails on the first Ghidra type.' },
  { gate: 7, keyword: 'Python', title: 'Python 3.12+ required for fra-annotate.py walrus operator', fix: 'The annotation script uses := (walrus operator, PEP 572) and match/case (PEP 634). Requires Python 3.12+. macOS ships 3.9 — install via pyenv or Homebrew.' },
  { gate: 8, keyword: 'Ollama', title: 'Ollama model pull required before first annotation run', fix: 'fra-annotate.py calls llama3 and phi3/qwen3.5 without checking availability. Run `ollama pull llama3 && ollama pull phi3` before the first pipeline run or the script fails with connection refused.' },
  { gate: 9, keyword: 'split', title: 'fra-eval.py re.split() produces 181 fragments from 136 functions', fix: 'The upstream evaluator uses re.split() on function markers, which creates empty strings at boundaries. Use re.findall() with the marker pattern instead — this correctly produces 136 function records.' },
  { gate: 10, keyword: 'npm', title: 'rea-agents npm install fails on native modules', fix: 'The rea-agents orchestrator (5,810 TS files) has native deps that require node-gyp + Python + make. On macOS ARM, ensure Xcode CLT is installed: `xcode-select --install`. Some deps need `npm rebuild` after arch switch.' },
  { gate: 11, keyword: 'seal', title: 'Dossier seal includes ghidra.log which is not committed', fix: 'The pipeline seals every file in the dossier directory including ghidra.log. The committed subset excludes ghidra.log, so seal recomputation from committed files will not match. This is NOT tampering — it is a missing file.' },
  { gate: 12, keyword: 'PATH', title: 'Pipeline scripts assume tools on PATH', fix: 'fra-pipeline.sh calls r2, ghidra, clang, python3 by bare name. All must be on PATH. Create a .env or wrapper script that prepends /opt/homebrew/bin:/usr/local/bin and the Ghidra support directory.' },
  { gate: 13, keyword: 'timeout', title: 'Hive nightly cron must complete before next run', fix: 'hive-nightly.sh uses scp over Tailnet (100.x.x.x) to push projections. If the previous run is still transferring (large dossier), launchd fires a second instance. Add a lockfile check at the top of the script.' },
  { gate: 14, keyword: 'receipt', title: 'Receipt chain breaks if hive-receipts.py crashes mid-append', fix: 'The append-only JSONL chain expects prev=last_self. If the process crashes after writing prev but before computing self, the chain is permanently broken. Atomic write: compose full JSON line in memory, then single write() call.' },
  { gate: 15, keyword: 'import', title: 'Import verification only confirms 3 of 78 Ghidra imports', fix: 'Ghidra marks 78 imports but only printf, putchar, strlen appear in the decompiled bodies. The other 75 are called indirectly via PLT stubs that Ghidra decompiles as FUN_ addresses. Import count != verified count.' },
  { gate: 16, keyword: 'annotation', title: 'qwen3.5 think-block contaminates annotations', fix: 'qwen3.5 sometimes emits <think>...</think> blocks in its annotation output. The parser does not strip these, so annotations contain reasoning traces. Filter with regex before storing: re.sub(r"<think>.*?</think>", "", text, flags=re.S).' },
  { gate: 17, keyword: 'Tailnet', title: 'Tailnet DNS resolution fails for Windows target', fix: 'hive-nightly.sh uses the Tailnet hostname (e.g., desktop-xyz) which requires MagicDNS. If MagicDNS is disabled, use the 100.x.x.x IP directly. Check with `tailscale status` on both machines.' },
  { gate: 18, keyword: 'permission', title: 'Ghidra project directory needs write permission for headless mode', fix: 'analyzeHeadless creates a .gpr/.rep project in the specified directory. If running as a different user (e.g., via cron), the directory may not be writable. Set permissions or use a per-user temp project path.' },
];

// ─── Build-gate seeding ──────────────────────────────────────────

export function seedBuildGates() {
  let seeded = 0;
  let skipped = 0;
  for (const g of BUILD_GATES) {
    const key = `build_gate_${g.gate}`;
    const value = JSON.stringify({ gate: g.gate, keyword: g.keyword, title: g.title, fix: g.fix });
    const result = storeMemory(RE_AGENT_ID, 'build_gate', key, value, { confidence: 0.9, source: 'BUILD-GATES.md (upstream, not reproduced locally)' });
    if (result.updated) { skipped++; } else { seeded++; }
  }
  return { seeded, skipped, total: BUILD_GATES.length };
}

// ─── RE fleet tools ──────────────────────────────────────────────

export function createRETools() {
  return [
    {
      name: 're.verify_chain',
      group: 'fleet',
      risk: 'safe',
      description: 'Verify the SHA-256 hash chain of a raw hive receipt file. Returns chain integrity status.',
      parameters: object({
        path: string(1000, { description: 'Path to hive receipts JSONL file. Defaults to the standard raw receipt path.' }),
      }),
      execute: async ({ args }) => {
        const result = verifyHiveChain(args.path || undefined);
        return result;
      },
    },
    {
      name: 're.build_gate_lookup',
      group: 'fleet',
      risk: 'safe',
      description: 'Search known build failure patterns (gates) from upstream BUILD-GATES.md by keyword.',
      parameters: object({
        keyword: string(200, { description: 'Keyword to search for in build gate entries (e.g., "JDK", "dylib", "npm").' }),
      }, ['keyword']),
      execute: async ({ args }) => {
        const keyword = String(args.keyword || '').trim();
        if (!keyword) throw new Error('keyword required');
        const memories = recallMemories(RE_AGENT_ID, { category: 'build_gate', query: keyword, limit: 18 });
        const gates = memories.map(m => {
          try { return { ...JSON.parse(m.value), confidence: m.confidence, verified: !!m.verified_at }; }
          catch (_) { return { raw: m.value, confidence: m.confidence }; }
        });
        return { keyword, matches: gates.length, gates };
      },
    },
    {
      name: 're.ingest_dossier',
      group: 'fleet',
      risk: 'safe',
      description: 'Ingest a sealed dossier directory (decompiled.c, annotations, imports, seal). Requires Phase 3 dossier engine.',
      parameters: object({
        dossierPath: string(1000, { description: 'Path to the dossier directory.' }),
      }, ['dossierPath']),
      execute: async ({ args }) => {
        throw new Error('re.ingest_dossier requires the Phase 3 dossier engine (server/intelligence/dossier-engine.js). Not yet implemented.');
      },
    },
    {
      name: 're.query_dossier',
      group: 'fleet',
      risk: 'safe',
      description: 'Query ingested dossier data by binary SHA, function name, or free text. Requires Phase 3 dossier engine.',
      parameters: object({
        binarySha: string(64, { description: 'SHA-256 of the analyzed binary.' }),
        functionName: string(200, { description: 'Function name to search for.' }),
        query: string(500, { description: 'Free text search across dossier memories.' }),
      }),
      execute: async ({ args }) => {
        throw new Error('re.query_dossier requires the Phase 3 dossier engine (server/intelligence/dossier-engine.js). Not yet implemented.');
      },
    },
    {
      name: 're.compile_rate_measure',
      group: 'fleet',
      risk: 'safe',
      description: 'Measure actual compile rate of decompiled C using clang -fsyntax-only. Requires Phase 3 dossier engine.',
      parameters: object({
        dossierPath: string(1000, { description: 'Path to the dossier directory containing decompiled.c.' }),
      }, ['dossierPath']),
      execute: async ({ args }) => {
        throw new Error('re.compile_rate_measure requires the Phase 3 dossier engine (server/intelligence/dossier-engine.js). Not yet implemented.');
      },
    },
    {
      name: 're.compile_rate_predict',
      group: 'fleet',
      risk: 'safe',
      description: 'LLM-predicted compile rate (model opinion, NOT compiler measurement). Requires Phase 3 dossier engine.',
      parameters: object({
        dossierPath: string(1000, { description: 'Path to the dossier directory containing decompiled.c.' }),
      }, ['dossierPath']),
      execute: async ({ args }) => {
        throw new Error('re.compile_rate_predict requires the Phase 3 dossier engine (server/intelligence/dossier-engine.js). Not yet implemented.');
      },
    },
  ];
}
