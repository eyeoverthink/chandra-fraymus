import { verifyHiveChain } from '../intelligence/hive-bridge.js';
import { recallMemories, storeMemory } from './agent-memory.js';
import { db } from '../db.js';
import { processDossier, getDossier, getDossierFunctions, getDossierFunction, parseDossier } from '../intelligence/dossier-engine.js';

const RE_AGENT_ID = 're-analyst';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

// ─── 18 upstream build gates ──────────────────────────────────
// Authentic lessons from BUILD-GATES.md at upstream commit 2f75cee7
// (Git blob 43377715d18c7d892fa71c3dab3167da070f6936).
// Gate numbers 1–18 match the upstream document's numbering exactly.
// Stored at confidence 0.9 — observed on darwin-arm64, not this machine.
// Confidence upgraded to 1.0 only when independently reproduced locally.

const UPSTREAM_SOURCE = 'BUILD-GATES.md at upstream 2f75cee7 (blob 43377715)';

const BUILD_GATES = [
  { gate: 1, keyword: 'sudo', title: 'r2 sys/install.sh — sudo hang', fix: './configure --prefix=$HOME/fraymus-re/tools/r2 && make install — user-owned prefix, zero elevation.' },
  { gate: 2, keyword: 'dylib', title: 'r2 dylib path decay', fix: 'export DYLD_FALLBACK_LIBRARY_PATH=$HOME/fraymus-re/tools/r2/lib (saved to tools/r2/r2env.sh).' },
  { gate: 3, keyword: 'JDK', title: 'Ghidra JDK 21 daemon crash', fix: 'brew install openjdk@25, JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home.' },
  { gate: 4, keyword: 'flatRepo', title: 'Ghidra build #3 — missing flat repo', fix: './gradlew -I gradle/support/fetchDependencies.gradle init before buildGhidra.' },
  { gate: 5, keyword: 'npm', title: 'rea engine gate (EBADENGINE)', fix: '--engine-strict=false for install, but see gate 6 for genuine runtime incompatibility.' },
  { gate: 6, keyword: 'runtime', title: 'rea genuine runtime incompat', fix: 'brew install node@24 side-by-side, PATH-prefix /opt/homebrew/opt/node@24/bin for rea builds only.' },
  { gate: 7, keyword: 'install-scripts', title: 'npm 11 install-scripts block', fix: 'npm install-scripts approve esbuild fsevents then reinstall/build.' },
  { gate: 8, keyword: 'git', title: 'rea prepare.mjs needs .git', fix: 'git init + snapshot commit in rea-main.' },
  { gate: 9, keyword: 'entrypoint', title: 'rea entrypoint law', fix: 'Run node scripts/rea.mjs --version; runtime self-diagnoses missing build — npm ci && npm run build:cached.' },
  { gate: 10, keyword: 'TTY', title: 'Ghidra JDK prompt with no TTY', fix: 'java -cp support/LaunchSupport.jar LaunchSupport $GH -jdk_home -save with JAVA_HOME set.' },
  { gate: 11, keyword: 'analyzeHeadless', title: 'Bad argument: /bin/ls', fix: '-import /bin/ls (flag is mandatory for analyzeHeadless).' },
  { gate: 12, keyword: 'ghidra-projects', title: 'Directory not found (ghidra-projects)', fix: 'mkdir -p ~/fraymus-re/ghidra-projects first.' },
  { gate: 13, keyword: 'PyGhidra', title: 'Ghidra 12 headless python = gone', fix: 'Java GhidraScript (decompile_all.java) + -process ls -noanalysis -scriptPath -postScript. Result: 136 functions, 5152 lines of C.' },
  { gate: 14, keyword: 'brew', title: 'Node runtime heals itself via brew', fix: 'brew upgrade node — v26.13.0 (>= their pin), simdjson decay gone.' },
  { gate: 15, keyword: 'gradle', title: 'ReVa gradle root confusion', fix: 'Build at repo ROOT with Gradle 9.1+ via gradle directly (not ./gradlew), with GHIDRA_INSTALL_DIR + JAVA_HOME set.' },
  { gate: 16, keyword: 'setuptools', title: 'setuptools-scm needs git metadata', fix: 'git init + snapshot commit, then pip install -e . — mcp-reva --help.' },
  { gate: 17, keyword: 'regex', title: 'FRA score v1 verified nothing — regex fault', fix: 'Proper column parse for rabin2 -i + per-model token budgets. Verified result: 3/78 (printf, putchar, strlen).' },
  { gate: 18, keyword: 'r2ai', title: 'r2ai build gates', fix: 'Pass R2USRPLUGDIR/R2BINDIR/R2MANDIR explicitly, bypass r2check with make -o r2check, set PKG_CONFIG_PATH, rename dylib, use positional args not -q.' },
];

// ─── Build-gate seeding (non-destructive + upgrade-safe) ──────
// Identity scope matches storeMemory's UNIQUE(agent_id, key) index:
// skip logic queries by key across ALL categories, so recategorized
// entries are never silently overwritten. Verified entries are always
// preserved regardless of category. Unverified entries from prior
// seeding formats are updated with authentic upstream content.
// Orphaned L-prefixed entries (from the e8410f3 reconstructed format)
// are cleaned up if unverified.

export function seedBuildGates() {
  let seeded = 0;
  let skipped = 0;
  let updated = 0;
  let cleaned = 0;

  // Query ALL existing keys for this agent with build_gate prefix — any category.
  // This matches storeMemory's (agent_id, key) identity scope.
  const existingByKey = new Map(
    db.prepare(`SELECT key, category, confidence, verified_at, source FROM agent_memories WHERE agent_id = ? AND key LIKE 'build_gate_%'`)
      .all(RE_AGENT_ID)
      .map(r => [r.key, r])
  );

  for (const g of BUILD_GATES) {
    const key = `build_gate_${g.gate}`;
    const existing = existingByKey.get(key);

    if (existing && existing.verified_at) {
      // Locally verified — preserve regardless of category or content
      skipped++;
      continue;
    }

    const value = JSON.stringify({ gate: g.gate, keyword: g.keyword, title: g.title, fix: g.fix });

    if (existing) {
      // Check if content and source already match — skip needless DB writes
      const currentValue = db.prepare(`SELECT value, source FROM agent_memories WHERE agent_id = ? AND key = ?`).get(RE_AGENT_ID, key);
      if (currentValue && currentValue.value === value && currentValue.source === UPSTREAM_SOURCE) {
        skipped++;
        continue;
      }
      // Exists but content differs or not verified — update with authentic upstream content
      storeMemory(RE_AGENT_ID, 'build_gate', key, value, { confidence: 0.9, source: UPSTREAM_SOURCE });
      updated++;
    } else {
      // New entry
      storeMemory(RE_AGENT_ID, 'build_gate', key, value, { confidence: 0.9, source: UPSTREAM_SOURCE });
      seeded++;
    }
  }

  // Clean up orphaned L-prefixed entries from the e8410f3 reconstructed format
  const orphanedKeys = [...existingByKey.keys()].filter(k => /^build_gate_L\d+$/.test(k));
  for (const key of orphanedKeys) {
    const entry = existingByKey.get(key);
    if (!entry.verified_at) {
      db.prepare(`DELETE FROM agent_memories WHERE agent_id = ? AND key = ?`).run(RE_AGENT_ID, key);
      cleaned++;
    }
    // Verified L-entries are preserved as historical local corrections
  }

  return { seeded, skipped, updated, cleaned, total: BUILD_GATES.length };
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
      description: 'Search known build failure patterns (gates) from upstream BUILD-GATES.md (2f75cee7) by keyword. Returns gate number, title, fix, provenance, confidence, and verification status.',
      parameters: object({
        keyword: string(200, { description: 'Keyword to search for in build gate entries (e.g., "JDK", "dylib", "npm").' }),
      }, ['keyword']),
      execute: async ({ args }) => {
        const keyword = String(args.keyword || '').trim();
        if (!keyword) throw new Error('keyword required');
        const memories = recallMemories(RE_AGENT_ID, { category: 'build_gate', query: keyword, limit: 18 });
        const gates = memories.map(m => {
          try { return { ...JSON.parse(m.value), confidence: m.confidence, verified: !!m.verified_at, source: m.source }; }
          catch (_) { return { raw: m.value, confidence: m.confidence, source: m.source }; }
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
        const path = String(args.dossierPath || '').trim();
        if (!path) throw new Error('dossierPath required');
        return processDossier(path);
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
        const sha = String(args.binarySha || '').trim();
        const fnName = String(args.functionName || '').trim();
        const query = String(args.query || '').trim();

        if (sha && fnName) {
          const fn = getDossierFunction(sha, fnName);
          if (!fn) return { error: 'Function not found in dossier', binarySha: sha, functionName: fnName };
          return fn;
        }
        if (sha) {
          const dossier = getDossier(sha);
          if (!dossier) return { error: 'Dossier not found', binarySha: sha };
          return dossier;
        }
        if (fnName) {
          // Function name search across all binaries
          const memories = recallMemories(RE_AGENT_ID, { category: 'binary_dossier', query: fnName, limit: 20 });
          const matches = memories
            .filter(m => m.key.startsWith('fn:') && m.key.includes(fnName))
            .map(m => {
              try {
                const val = JSON.parse(m.value);
                return { key: m.key, ...val, confidence: m.confidence, verified: !!m.verified_at, source: m.source };
              } catch (_) { return null; }
            })
            .filter(Boolean);
          return { functionName: fnName, matches: matches.length, results: matches };
        }
        if (query) {
          const memories = recallMemories(RE_AGENT_ID, { category: 'binary_dossier', query, limit: 20 });
          return { query, matches: memories.length, results: memories };
        }
        throw new Error('At least one of binarySha, functionName, or query required');
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
        const path = String(args.dossierPath || '').trim();
        if (!path) throw new Error('dossierPath required');
        const parsed = parseDossier(path);
        const { execFileSync } = await import('node:child_process');
        const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');

        // Detect compiler availability before attempting compilation
        let compilerAvailable = false;
        try {
          execFileSync('clang', ['--version'], { timeout: 5_000, stdio: 'pipe' });
          compilerAvailable = true;
        } catch (_) {
          // clang not found or not executable
        }

        if (!compilerAvailable) {
          return {
            binary: parsed.binary,
            total: parsed.functions.length,
            compiled: null,
            failed: null,
            compileRate: null,
            compiler: 'not_available',
            detail: 'clang not found in PATH — cannot measure compile rate',
          };
        }

        // Use OS temp with cryptographic randomness to prevent collisions
        const tmpDir = mkdtempSync(join(tmpdir(), 'chandra-compile-'));

        let compiled = 0;
        let failed = 0;
        const errors = [];
        const createdFiles = [];

        try {
          for (let i = 0; i < parsed.functions.length; i++) {
            const fn = parsed.functions[i];
            // Sanitized filename: index-based, no user-controlled path components
            const safeFile = join(tmpDir, `fn_${i}.c`);
            createdFiles.push(safeFile);
            try {
              writeFileSync(safeFile, fn.body);
              // Spawn with argument vector — no shell interpolation
              execFileSync('clang', ['-fsyntax-only', '-w', safeFile], { timeout: 10_000, stdio: 'pipe' });
              compiled++;
            } catch (e) {
              failed++;
              errors.push({ name: fn.name, address: fn.address, error: e.stderr?.toString().slice(0, 200) || e.message });
            }
          }
        } finally {
          // Clean up only files we created, in our own temp directory
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }

        const total = parsed.functions.length;
        const rate = total > 0 ? Math.round((compiled / total) * 10000) / 100 : 0;

        return {
          binary: parsed.binary,
          total,
          compiled,
          failed,
          compileRate: rate,
          compiler: 'clang',
          sampleErrors: errors.slice(0, 5),
        };
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
        const path = String(args.dossierPath || '').trim();
        if (!path) throw new Error('dossierPath required');
        const parsed = parseDossier(path);

        const sample = parsed.functions.slice(0, 5).map(fn => ({
          name: fn.name,
          address: fn.address,
          lines: fn.lines,
          snippet: fn.body.slice(0, 300),
        }));

        const { chatOllama } = await import('../commerce/shared.js');
        const prompt = `You are a compiler diagnostics expert. Given these decompiled C function samples from Ghidra/radare2, estimate what percentage would pass \`clang -fsyntax-only\`. Consider: missing includes, undefined types, Ghidra-specific pseudo-types, calling conventions, assembly inlines.

Binary: ${parsed.binary}
Total functions: ${parsed.functions.length}
Import count: ${parsed.imports.length}

Sample functions:
${sample.map(s => `--- ${s.name} @ ${s.address} (${s.lines} lines) ---\n${s.snippet}`).join('\n\n')}

Respond with JSON only: {"predictedRate": <number 0-100>, "confidence": <"low"|"medium"|"high">, "reasoning": "<one sentence>"}`;

        let modelId = 'unknown';
        try {
          const { default: config } = await import('../config.js');
          modelId = config.OLLAMA_MODEL || 'default';
        } catch (_) {}

        const response = await chatOllama([{ role: 'user', content: prompt }], { temperature: 0.2 });
        let prediction;
        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          prediction = jsonMatch ? JSON.parse(jsonMatch[0]) : { predictedRate: null, confidence: 'low', reasoning: 'Could not parse LLM response' };
        } catch (_) {
          prediction = { predictedRate: null, confidence: 'low', reasoning: 'LLM response was not valid JSON' };
        }

        // Range validation: predictedRate must be 0-100
        if (typeof prediction.predictedRate === 'number') {
          if (prediction.predictedRate < 0 || prediction.predictedRate > 100) {
            prediction.predictedRate = Math.max(0, Math.min(100, prediction.predictedRate));
            prediction.reasoning = (prediction.reasoning || '') + ' [rate clamped to 0-100 range]';
          }
        }

        // Validate confidence is one of the allowed values
        const VALID_CONFIDENCES = ['low', 'medium', 'high'];
        if (!VALID_CONFIDENCES.includes(prediction.confidence)) {
          prediction.confidence = 'low';
        }

        return {
          binary: parsed.binary,
          totalFunctions: parsed.functions.length,
          importCount: parsed.imports.length,
          sampleSize: sample.length,
          evidence_type: 'llm_prediction',
          model: modelId,
          evidence_confidence: 0.4,
          prediction,
          note: 'This is an LLM opinion, NOT a compiler measurement. Use re.compile_rate_measure for ground truth.',
        };
      },
    },
  ];
}
