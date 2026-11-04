import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// ── Strix Laws — 5 Loop Discipline Laws ────────────────────────
// Ported from FRAYNIX tools/strix_laws.py. Each law is independently
// callable and selftest-proven. Together they enforce agent loop quality.

const SPILL_DIR = join(process.cwd(), 'data', 'spill');
const SALVAGE_DIR = join(process.cwd(), 'data', 'salvage');
const SKILLS_DIR = join(process.cwd(), 'data', 'skills');

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// ── LAW 1: Compaction ──────────────────────────────────────────
// Replaces older complete step-pairs (user+assistant or tool+assistant)
// with harness-composed checkpoints. Keeps last KEEP_RECENT verbatim.
// Never orphans a tool_result from its tool_call.

const COMPACTION_THRESHOLD_CHARS = 9500;
const KEEP_RECENT_PAIRS = 2;

export function maybeCompact(history, threshold = COMPACTION_THRESHOLD_CHARS, keepRecent = KEEP_RECENT_PAIRS) {
  const totalChars = history.reduce((s, m) => s + (m.content?.length || 0), 0);
  if (totalChars <= threshold) return { compacted: false, history, totalChars };

  // Find complete pairs (request + response) — never split tool_call from tool_result
  const pairs = [];
  let i = 0;
  while (i < history.length) {
    if (history[i].role === 'system') { i++; continue; }

    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'assistant') {
      pairs.push({ start: i, end: i + 1, msgs: [history[i], history[i + 1]] });
      i += 2;
    } else if (history[i].role === 'assistant' && history[i].tool_calls && i + 1 < history.length && history[i + 1].role === 'tool') {
      // Tool call + tool result — keep together, never orphan
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') j++;
      pairs.push({ start: i, end: j - 1, msgs: history.slice(i, j) });
      i = j;
    } else {
      pairs.push({ start: i, end: i, msgs: [history[i]] });
      i++;
    }
  }

  if (pairs.length <= keepRecent) return { compacted: false, history, totalChars };

  // Keep system messages + compact older pairs + keep recent verbatim
  const systemMsgs = history.filter(m => m.role === 'system');
  const toCompact = pairs.slice(0, pairs.length - keepRecent);
  const toKeep = pairs.slice(pairs.length - keepRecent);

  const checkpoint = toCompact.map(p => {
    const summary = p.msgs.map(m => `[${m.role}] ${(m.content || '').slice(0, 80)}`).join(' → ');
    return summary;
  }).join('\n');

  const compactedMsg = {
    role: 'system',
    content: `[Compacted ${toCompact.length} step-pairs by Strix Law 1]\n${checkpoint}`,
  };

  const result = [...systemMsgs, compactedMsg, ...toKeep.flatMap(p => p.msgs)];
  const newChars = result.reduce((s, m) => s + (m.content?.length || 0), 0);

  return { compacted: true, history: result, originalChars: totalChars, newChars, pairsCompacted: toCompact.length };
}

// ── LAW 2: Salvage on Crash ────────────────────────────────────
// Persists partial history on any error. No work is ever lost mid-loop.

export function salvageOnCrash(runId, history, error) {
  if (!existsSync(SALVAGE_DIR)) mkdirSync(SALVAGE_DIR, { recursive: true });

  const salvage = {
    runId,
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 5) || [],
    historyLength: history.length,
    history: history.map(m => ({
      role: m.role,
      content: (m.content || '').slice(0, 2000),
      tool_calls: m.tool_calls ? m.tool_calls.length : undefined,
    })),
    savedAt: new Date().toISOString(),
  };

  const filename = `salvage-${runId}-${Date.now()}.json`;
  const filepath = join(SALVAGE_DIR, filename);
  writeFileSync(filepath, JSON.stringify(salvage, null, 2));

  return { salvaged: true, file: filename, historyLength: history.length };
}

// ── LAW 3: Budget Bands ────────────────────────────────────────
// Fires warnings at configurable thresholds of step budget.
// Returns injection text for the agent's context.

const DEFAULT_BUDGET_WARNS = [0.60, 0.75, 0.85];
const DEFAULT_REPORT_RESERVE = 0.85;

export function budgetBands(currentStep, maxSteps, warns = DEFAULT_BUDGET_WARNS, reportReserve = DEFAULT_REPORT_RESERVE) {
  const ratio = currentStep / maxSteps;
  const directives = [];
  let urgency = 'normal';

  for (const threshold of warns) {
    if (ratio >= threshold) {
      const pct = Math.round(threshold * 100);
      directives.push(`⚠ Budget ${pct}% consumed (step ${currentStep}/${maxSteps})`);
      urgency = ratio >= reportReserve ? 'critical' : ratio >= 0.75 ? 'high' : 'warning';
    }
  }

  if (ratio >= reportReserve) {
    directives.push('CRITICAL: Reserve your remaining steps for the final report/deliverable. No new exploration.');
  }

  return {
    ratio: Math.round(ratio * 100) / 100,
    urgency,
    directives,
    injectionText: directives.length > 0
      ? `\n[Strix Law 3 — Budget]\n${directives.join('\n')}\n`
      : '',
  };
}

// ── LAW 4: Bounded Results ─────────────────────────────────────
// Caps tool output. Full text spilled to disk with SHA-256 reference.

const BOUNCE_MAX_LINES = 48;
const BOUNCE_MAX_CHARS = 4000;

export function boundResult(result, maxChars = BOUNCE_MAX_CHARS, maxLines = BOUNCE_MAX_LINES) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  const lines = str.split('\n');

  if (str.length <= maxChars && lines.length <= maxLines) {
    return { bounded: false, text: str, fullLength: str.length };
  }

  // Spill full result to disk
  if (!existsSync(SPILL_DIR)) mkdirSync(SPILL_DIR, { recursive: true });
  const spillHash = sha256(str);
  const spillFile = join(SPILL_DIR, `spill-${spillHash.slice(0, 16)}.txt`);
  writeFileSync(spillFile, str);

  // Truncate for context
  const truncatedLines = lines.slice(0, maxLines);
  let truncated = truncatedLines.join('\n');
  if (truncated.length > maxChars) truncated = truncated.slice(0, maxChars);

  return {
    bounded: true,
    text: truncated + `\n[… truncated: ${str.length} chars / ${lines.length} lines → spill ${spillHash.slice(0, 16)}]`,
    fullLength: str.length,
    fullLines: lines.length,
    spillFile: basename(spillFile),
    spillHash,
  };
}

// Read a spilled result by its hash prefix.
export function readSpill(hashPrefix) {
  if (!existsSync(SPILL_DIR)) return null;
  const files = readdirSync(SPILL_DIR).filter(f => f.includes(hashPrefix));
  if (files.length === 0) return null;
  return readFileSync(join(SPILL_DIR, files[0]), 'utf8');
}

// ── LAW 5: Skills as Templates ─────────────────────────────────
// Markdown files with YAML frontmatter. Task-matched selection capped at SKILL_CAP.

const SKILL_CAP = 2;

export function selectSkills(taskDescription, skillDirs = [SKILLS_DIR], cap = SKILL_CAP) {
  const skills = [];

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { recursive: true })
      .filter(f => typeof f === 'string' && extname(f) === '.md');

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!frontmatterMatch) continue;

        const meta = {};
        for (const line of frontmatterMatch[1].split('\n')) {
          const [key, ...rest] = line.split(':');
          if (key && rest.length) meta[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
        }

        const body = frontmatterMatch[2];
        const name = meta.name || basename(file, '.md');
        const description = meta.description || '';

        // Score: how many task words appear in name + description
        const taskWords = taskDescription.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        const haystack = (name + ' ' + description).toLowerCase();
        const score = taskWords.reduce((s, w) => s + (haystack.includes(w) ? 1 : 0), 0);

        skills.push({ name, description, file: String(file), score, body });
      } catch (_) {}
    }
  }

  // Sort by score descending, cap at SKILL_CAP
  const selected = skills
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);

  return {
    matched: selected.length,
    total: skills.length,
    skills: selected.map(s => ({ name: s.name, description: s.description, file: s.file, score: s.score })),
    injectionText: selected.length > 0
      ? selected.map(s => `[Skill: ${s.name}]\n${s.body}`).join('\n\n')
      : '',
  };
}

// ── Combined Law Check ─────────────────────────────────────────
// Run all applicable laws for a given loop step. Returns combined directives.

export function checkLaws(history, step, maxSteps, toolResult = null) {
  const directives = [];

  // Law 1: check if compaction needed
  const compaction = maybeCompact(history);
  if (compaction.compacted) {
    directives.push({ law: 1, action: 'compacted', detail: `${compaction.pairsCompacted} pairs compacted` });
  }

  // Law 3: budget check
  const budget = budgetBands(step, maxSteps);
  if (budget.directives.length > 0) {
    directives.push({ law: 3, action: 'budget_warning', urgency: budget.urgency, detail: budget.directives.join('; ') });
  }

  // Law 4: bound tool result if provided
  let boundedResult = null;
  if (toolResult != null) {
    const bounded = boundResult(toolResult);
    if (bounded.bounded) {
      boundedResult = bounded;
      directives.push({ law: 4, action: 'result_bounded', detail: `${bounded.fullLength} chars → ${bounded.text.length} chars, spill=${bounded.spillHash?.slice(0, 12)}` });
    }
  }

  return {
    directives,
    history: compaction.compacted ? compaction.history : history,
    budgetInjection: budget.injectionText,
    boundedResult,
  };
}

// ── Selftest ───────────────────────────────────────────────────
// Proves all 5 laws independently. No LLM, no network.

export function selftest() {
  const results = [];

  // Law 1: Compaction
  const bigHistory = [];
  for (let i = 0; i < 20; i++) {
    bigHistory.push({ role: 'user', content: 'x'.repeat(500) });
    bigHistory.push({ role: 'assistant', content: 'y'.repeat(500) });
  }
  const c1 = maybeCompact(bigHistory, 5000, 2);
  results.push({ test: 'law1_compacts', pass: c1.compacted === true && c1.pairsCompacted > 0 });

  const smallHistory = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  const c2 = maybeCompact(smallHistory);
  results.push({ test: 'law1_skips_small', pass: c2.compacted === false });

  // Law 2: Salvage
  const s1 = salvageOnCrash('test-run-123', [{ role: 'user', content: 'test' }], new Error('boom'));
  results.push({ test: 'law2_salvages', pass: s1.salvaged === true && s1.historyLength === 1 });

  // Law 3: Budget bands
  const b1 = budgetBands(7, 10);
  results.push({ test: 'law3_warns_at_70pct', pass: b1.urgency !== 'normal' && b1.directives.length > 0 });

  const b2 = budgetBands(2, 10);
  results.push({ test: 'law3_quiet_at_20pct', pass: b2.urgency === 'normal' && b2.directives.length === 0 });

  const b3 = budgetBands(9, 10);
  results.push({ test: 'law3_critical_at_90pct', pass: b3.urgency === 'critical' });

  // Law 4: Bounded results
  const bigResult = 'line\n'.repeat(100);
  const br1 = boundResult(bigResult, 200, 10);
  results.push({ test: 'law4_bounds_large', pass: br1.bounded === true && br1.spillHash?.length === 64 });

  const smallResult = 'ok';
  const br2 = boundResult(smallResult);
  results.push({ test: 'law4_passes_small', pass: br2.bounded === false });

  // Law 5: Skills (basic structure test)
  const sk1 = selectSkills('nonexistent gibberish query', ['/nonexistent/path']);
  results.push({ test: 'law5_empty_graceful', pass: sk1.matched === 0 });

  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
