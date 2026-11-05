// Read-only committed-source inventory and contract probes. Never imports the app.
// Usage: node scripts/check-re-agent-progress.mjs [--ref COMMIT] [--output PATH]
// Presence of source is not an acceptance pass: behavioral gates stay unverified.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const refFlag = process.argv.indexOf('--ref');
const sourceRef = git('rev-parse', '--verify', `${refFlag < 0 ? 'HEAD' : process.argv[refFlag + 1]}^{commit}`);
const tracked = new Set(git('ls-tree', '-r', '--name-only', sourceRef).split('\n'));
const hashes = {};
function read(path) {
  if (!tracked.has(path)) return null;
  const text = execFileSync('git', ['show', `${sourceRef}:${path}`], { cwd: root, encoding: 'utf8' });
  hashes[path] = createHash('sha256').update(text).digest('hex');
  return text;
}
const specPath = 'docs/RE-AGENT-INTEGRATION.md';
const spec = read(specPath);
assert.ok(spec, 'Integration spec is tracked');
const creates = [...spec.matchAll(/^\| CREATE \| `([^`]+)`/gm)].map(match => match[1]);
const modifications = [...spec.matchAll(/^\| MODIFY \| `([^`]+)`/gm)].map(match => match[1]);
const uniqueCreates = [...new Set(creates)];
const existingModifications = [...new Set(modifications)].filter(path => !uniqueCreates.includes(path));
const definitions = [
  { number: 1, requires: ['server/intelligence/hive-bridge.js', 'server/intelligence/hive-bridge-routes.js'], markers: { 'server/runtime.js': 'installHiveBridgeRoutes' } },
  { number: 2, requires: ['agents/re-analyst.md', 'server/fleet/re-tools.js'], markers: { 'server/fleet/tools.js': 'createRETools' } },
  { number: 3, requires: ['server/intelligence/dossier-engine.js', 'server/intelligence/dossier-engine-routes.js'], markers: { 'server/runtime.js': 'installDossierRoutes' } },
  { number: 4, requires: [], markers: { 'server/intelligence/debate.js': 'debateBinaryAnnotation', 'server/intelligence/dossier-engine.js': 'debateBinaryAnnotation' } },
  { number: 5, requires: [], markers: Object.fromEntries(['sensory-bridge', 'attention-gate', 'working-memory', 'habituation', 'predictive-processing', 'active-inference'].map(name => [`server/intelligence/${name}.js`, 'binary_insight'])) },
  { number: 6, requires: [], markers: { 'server/fraymus/workflows/definitions.js': 'DossierAnalysis', 'server/intelligence/reflection.js': 're_analyze', 'server/intelligence/opeg.js': 're_reanalysis' } },
  { number: 7, requires: ['server/intelligence/hive-export.js', 'server/intelligence/hive-export-routes.js'], markers: { 'server/daemon/engine.js': 'exportChandraReceipts', 'server/runtime.js': 'installHiveExportRoutes' } },
];
const phases = definitions.map(definition => {
  const block = spec.match(new RegExp(`^## Phase ${definition.number} [\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'm'))?.[0];
  assert.ok(block, `Phase ${definition.number} exists`);
  const name = block.split('\n')[0].replace(/^## /, '').trim();
  const requirements = [
    ...definition.requires.map(path => ({ path, present: tracked.has(path), requirement: 'tracked file' })),
    ...Object.entries(definition.markers).map(([path, marker]) => ({ path, marker, present: read(path)?.includes(marker) || false, requirement: 'integration marker; not behavior proof' })),
  ];
  const present = requirements.some(item => item.present);
  const status = present ? 'IMPLEMENTATION_DETECTED_NOT_VERIFIED' : 'NOT_IMPLEMENTED';
  const gates = [];
  let section = String(definition.number), sectionIndex = 0;
  for (const line of block.split('\n')) {
    const heading = line.match(/^### Verification Gate (\d+[AB]?)/);
    if (heading) { section = heading[1]; sectionIndex = 0; }
    const criterion = line.match(/^- \[([ xX])\] (.+)$/);
    if (criterion) gates.push({ id: `RE-P${section}-G${++sectionIndex}`, section, prerequisitePhase: section === '2B' ? 3 : definition.number > 1 ? definition.number - 1 : null, criterion: criterion[2].trim(), authorChecked: criterion[1] !== ' ', independentStatus: status === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED' : 'NOT_VERIFIED', evidence: null });
  }
  return { phase: definition.number, name, status, prerequisites: definition.number > 1 ? [definition.number - 1] : [], requirements, gates, verifiedGateCount: 0 };
});

const checks = [];
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
check('seven phases extracted', phases.length === 7);
check('each phase defines concrete criteria with unique identifiers', phases.every(phase => phase.gates.length > 0) && new Set(phases.flatMap(phase => phase.gates.map(gate => gate.id))).size === phases.reduce((sum, phase) => sum + phase.gates.length, 0));
const claimedNewFiles = Number(spec.match(/\*\*(\d+) new files\*\* created/)?.[1]);
const claimedModifiedFiles = Number(spec.match(/\*\*(\d+) existing files\*\* modified/)?.[1]);
check('file inventory matches the spec count', uniqueCreates.length === claimedNewFiles && existingModifications.length === claimedModifiedFiles);

// Reproduce the proposed manifest using the actual parser, without discovery or IO.
const manifestSource = read('server/fleet/manifest.js');
const parserText = manifestSource.match(/export function parseManifest\([\s\S]*?\n}/)?.[0];
const parseManifest = new vm.Script(`(${parserText.replace('export ', '')})`).runInNewContext();
const yaml = spec.match(/```yaml\n([\s\S]*?)```/)?.[1];
const parsed = parseManifest(yaml);
const csvTools = yaml.match(/^tools:[ \t]*([^\r\n]*)\r?$/m)?.[1]?.trim();
const intendedTools = csvTools ? csvTools.split(',').map(tool => tool.trim()) : [...yaml.matchAll(/^  - (.+)$/gm)].map(match => match[1]);
const commaControl = parseManifest(csvTools ? yaml : yaml.replace(/tools:\n(?:  - .+\n)+/, `tools: ${intendedTools.join(', ')}\n`));
check('actual parser behavior matches the manifest syntax under review', csvTools ? Array.isArray(parsed.tools) && JSON.stringify(parsed.tools) === JSON.stringify(intendedTools) : parsed.tools === '*');
check('comma-separated manifest positive control preserves tool restriction', Array.isArray(commaControl.tools) && commaControl.tools.length === intendedTools.length);

const workflow = read('server/workflow/engine.js');
const classifierSource = workflow.match(/function nodeKind\(type\) \{[\s\S]*?\n}/)?.[0];
const classify = new vm.Script(`(${classifierSource})`).runInNewContext();
const phaseSix = spec.match(/^## Phase 6 [\s\S]*?(?=^## Phase 7)/m)?.[0];
const workflowExample = phaseSix?.match(/```(?:js)?\n([\s\S]*?)```/)?.[1] || '';
const proposedTypes = [...new Set([...workflowExample.matchAll(/\btype:\s*'([^']+)'/g)].map(match => match[1]))];
const workflowKinds = Object.fromEntries([...new Set([...proposedTypes, 'start', 'agent_run', 'memory_recall', 'end'])].map(type => [type, classify(type)]));
check('proposed workflow vocabulary was inspected without executing it', proposedTypes.length > 0);
check('existing memory_recall positive control is supported', workflowKinds.memory_recall === 'memory_recall');

const habituationText = read('server/intelligence/habituation.js').replace(/^import [^\n]+;\r?$/gm, '').replace(/^export /gm, '');
const habituation = new vm.Script(`(() => { ${habituationText}\nreturn {computeNoveltyFactors}; })()`).runInNewContext({
  db: { prepare: () => ({ run() {} }) }, publish() {}, randomUUID,
  getAutonomyModifiers: () => ({ evolutionRate: 1 }), Date, Math, console,
});
const novelty = habituation.computeNoveltyFactors({ binary_insight: 1 });
check('current habituation ignores an unregistered binary_insight channel', !Object.hasOwn(novelty, 'binary_insight'));

const ledgerPath = 'C:/Users/eyeka/hive/hive_genesis.jsonl';
let ledger;
try {
  const size = statSync(ledgerPath).size;
  if (size > 10_000_000) throw new Error('Review input exceeds 10 MB bound');
  const bytes = readFileSync(ledgerPath);
  const rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  ledger = { path: ledgerPath, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), rows: rows.length, keys: rows[0] ? Object.keys(rows[0]) : [], rowsWithFullChain: rows.filter(row => typeof row.prev === 'string' && typeof row.self === 'string').length, rowsWithSource: rows.filter(row => typeof row.src === 'string').length };
} catch (error) { ledger = { path: ledgerPath, error: error.message }; }

const result = {
  generatedAt: new Date().toISOString(), sourceRef, headAtFinish: git('rev-parse', 'HEAD'), workingTree: git('status', '--short'),
  safety: 'Committed-source reads, source-isolated pure functions, bounded read of landing ledger; no app import, live DB, network calls, or bus publication',
  specPath, sourceHashes: hashes,
  plannedInventory: { newFiles: uniqueCreates, existingModifiedFiles: existingModifications, presentPlannedNewFiles: uniqueCreates.filter(path => tracked.has(path)), deletedFilesPlanned: 0 },
  summary: { phases: phases.length, implementationDetected: phases.filter(phase => phase.status !== 'NOT_IMPLEMENTED').length, independentlyVerifiedPhases: 0, independentGatePasses: 0, totalPhaseGates: phases.reduce((sum, phase) => sum + phase.gates.length, 0), gatesBySection: Object.fromEntries([...new Set(phases.flatMap(phase => phase.gates.map(gate => gate.section)))].map(section => [section, phases.flatMap(phase => phase.gates).filter(gate => gate.section === section).length])) },
  phases,
  contractChecks: { assertionCount: checks.length, checks, manifest: { specPath: uniqueCreates.find(path => path.endsWith('/re-analyst.md')), actualDefaultDirectory: 'agents/', parsedTools: parsed.tools, intendedTools, restricted: Array.isArray(parsed.tools) && parsed.tools.every(tool => !tool.includes('*')) && JSON.stringify(parsed.tools) === JSON.stringify(intendedTools), commaSeparatedControl: commaControl.tools }, proposedWorkflowTypes: proposedTypes, unsupportedProposedNodes: proposedTypes.filter(type => workflowKinds[type] === 'unknown'), workflowKinds, habituationOutputKeys: Object.keys(novelty), landingLedger: ledger },
  limitations: 'Static presence never passes a phase gate. Future implementations require their own behavior tests and independent evidence. Cross-machine runtime and upstream tool execution are not tested by this script.',
};
const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0) {
  assert.ok(process.argv[outputFlag + 1], '--output requires a path');
  writeFileSync(resolve(process.argv[outputFlag + 1]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ sourceRef, ...result.summary, diagnosticAssertions: checks.length, output: resolve(process.argv[outputFlag + 1]) }));
} else console.log(JSON.stringify(result, null, 2));
