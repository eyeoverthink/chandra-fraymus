import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

const SPILL_DIR = join(DATA_DIR, 'spill');
mkdirSync(SPILL_DIR, { recursive: true });

const DEFAULT_POLICY = {
  READ_BUDGET: 3,
  MAX_STEPS: 8,
  BUDGET_WARNS: [0.60, 0.75, 0.85],
  REPORT_RESERVE: 0.85,
  COMPACTION_THRESHOLD_CHARS: 9500,
  KEEP_RECENT_PAIRS: 2,
  BOUNCE_MAX_LINES: 48,
  BOUNCE_MAX_CHARS: 4000,
  SKILL_CAP: 2,
};

let _policy = { ...DEFAULT_POLICY };
let _broadcast = null;

export function initStrixLaws(opts = {}) {
  if (opts.policy) Object.assign(_policy, opts.policy);
  _broadcast = opts.broadcast || null;
  return { active: true, policy: { ..._policy } };
}

export function getPolicy() {
  return { ..._policy };
}

export function updatePolicy(patch) {
  Object.assign(_policy, patch);
  return { ..._policy };
}

// -- Law 4: Bounded Tool Outputs + Spill --

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function boundResult(raw, maxLines, maxChars) {
  const limit = maxLines || _policy.BOUNCE_MAX_LINES;
  const charLimit = maxChars || _policy.BOUNCE_MAX_CHARS;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);

  if (text.length <= charLimit) {
    const hash = sha256(text);
    return { text, hash, spilled: false, originalLength: text.length };
  }

  const hash = sha256(text);
  const spillName = `${hash.slice(0, 16)}.spill.txt`;
  const spillPath = join(SPILL_DIR, spillName);
  writeFileSync(spillPath, text);

  const lines = text.split('\n');
  const headCount = Math.ceil(limit / 2);
  const tailCount = Math.floor(limit / 2);
  const head = lines.slice(0, headCount).join('\n');
  const tail = lines.slice(-tailCount).join('\n');

  const bounded = `${head}\n\n--- SPILLED (${text.length} chars, sha256=${hash.slice(0, 16)}) → ${spillPath} ---\n\n${tail}`;

  return {
    text: bounded.slice(0, charLimit),
    hash,
    spilled: true,
    spillPath,
    originalLength: text.length,
    boundedLength: bounded.length,
  };
}

export function readSpill(hash) {
  const spillName = `${hash.slice(0, 16)}.spill.txt`;
  const spillPath = join(SPILL_DIR, spillName);
  if (!existsSync(spillPath)) return null;
  return readFileSync(spillPath, 'utf-8');
}

// -- Law 3: Budget Phases + Reserve --

export function budgetCheck(step, totalSteps) {
  const maxSteps = totalSteps || _policy.MAX_STEPS;
  const fraction = step / maxSteps;
  const warnings = [];

  for (const threshold of _policy.BUDGET_WARNS) {
    if (fraction >= threshold) {
      warnings.push({
        level: threshold >= 0.85 ? 'critical' : threshold >= 0.75 ? 'high' : 'warning',
        threshold,
        message: `Budget ${Math.round(fraction * 100)}% consumed (${step}/${maxSteps} steps)`,
      });
    }
  }

  const reserveHit = fraction >= _policy.REPORT_RESERVE;

  return {
    step,
    maxSteps,
    fraction: Math.round(fraction * 100) / 100,
    warnings: warnings.length > 0 ? warnings.slice(-1) : [],
    reserveHit,
    canRead: !reserveHit,
    canExecute: fraction < 1.0,
  };
}

// -- Law 1: Exhaustive Compaction --

export function compactHistory(history, opts = {}) {
  const threshold = opts.threshold || _policy.COMPACTION_THRESHOLD_CHARS;
  const keepRecent = opts.keepRecent || _policy.KEEP_RECENT_PAIRS;

  const totalChars = history.reduce((s, m) => s + (m.content?.length || 0), 0);
  if (totalChars <= threshold) {
    return { compacted: false, history, totalChars, reason: 'under threshold' };
  }

  const pairs = [];
  let current = null;
  for (const msg of history) {
    if (msg.role === 'user') {
      if (current) pairs.push(current);
      current = { user: msg, responses: [] };
    } else if (current) {
      current.responses.push(msg);
    }
  }
  if (current) pairs.push(current);

  if (pairs.length <= keepRecent) {
    return { compacted: false, history, totalChars, reason: 'too few pairs' };
  }

  const oldPairs = pairs.slice(0, -keepRecent);
  const recentPairs = pairs.slice(-keepRecent);

  const checkpointLines = [];
  for (const pair of oldPairs) {
    const userMsg = pair.user.content?.slice(0, 200) || '[empty]';
    const responses = pair.responses.map(r => {
      if (r.role === 'tool') {
        const name = r.name || 'unknown';
        const content = r.content?.slice(0, 100) || '';
        return `  tool(${name}): ${content}`;
      }
      return `  assistant: ${(r.content || '').slice(0, 200)}`;
    });
    checkpointLines.push(`[STEP] user: ${userMsg}`);
    checkpointLines.push(...responses);
  }

  const checkpoint = {
    role: 'system',
    content: `[COMPACTED HISTORY — ${oldPairs.length} exchanges]\n${checkpointLines.join('\n')}`,
  };

  const compactedHistory = [checkpoint];
  for (const pair of recentPairs) {
    compactedHistory.push(pair.user);
    compactedHistory.push(...pair.responses);
  }

  const newChars = compactedHistory.reduce((s, m) => s + (m.content?.length || 0), 0);

  return {
    compacted: true,
    history: compactedHistory,
    originalChars: totalChars,
    compactedChars: newChars,
    exchangesCompacted: oldPairs.length,
    exchangesKept: recentPairs.length,
  };
}

// -- Law 2: Salvage on Crash --

const SALVAGE_DIR = join(DATA_DIR, 'salvage');
mkdirSync(SALVAGE_DIR, { recursive: true });

export function salvageOnCrash(runId, history, error) {
  const salvageFile = join(SALVAGE_DIR, `${runId}.salvage.json`);
  const salvage = {
    runId,
    timestamp: Date.now(),
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 5) || [],
    historyLength: history?.length || 0,
    history: (history || []).map(m => ({
      role: m.role,
      content: (m.content || '').slice(0, 500),
      name: m.name,
    })),
  };

  try {
    writeFileSync(salvageFile, JSON.stringify(salvage, null, 2));
    if (_broadcast) {
      _broadcast('integrity', { type: 'salvage', runId, file: salvageFile });
    }
    return { saved: true, file: salvageFile };
  } catch (e) {
    return { saved: false, error: e.message };
  }
}

export function listSalvage() {
  mkdirSync(SALVAGE_DIR, { recursive: true });
  try {
    const files = readdirSync(SALVAGE_DIR)
      .filter(f => f.endsWith('.salvage.json'))
      .sort().reverse().slice(0, 50);
    return files.map(f => {
      const p = join(SALVAGE_DIR, f);
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        return { file: f, runId: data.runId, timestamp: data.timestamp, error: data.error, historyLength: data.historyLength };
      } catch {
        return { file: f, error: 'unreadable' };
      }
    });
  } catch {
    return [];
  }
}

// -- Law 4 continued: Anti-Invention Seal --

export function sealToolResult(toolName, args, result, durationMs) {
  const payload = JSON.stringify({ tool: toolName, args, result });
  const hash = sha256(payload);
  return {
    tool: toolName,
    hash: hash.slice(0, 32),
    sealed_at: Date.now(),
    duration_ms: durationMs,
    result_type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    result_length: payload.length,
  };
}

// -- Law 5: Skills as Prompt Templates (capability already exists in Chandra via agent manifests, this adds cap enforcement) --

export function enforceSkillCap(requestedSkills, cap) {
  const limit = cap || _policy.SKILL_CAP;
  if (requestedSkills.length <= limit) {
    return { skills: requestedSkills, capped: false };
  }
  return {
    skills: requestedSkills.slice(0, limit),
    capped: true,
    dropped: requestedSkills.slice(limit),
    limit,
  };
}

// -- Selftest --

export function selftest() {
  const results = [];

  // Law 4: bound_result
  const longText = 'x'.repeat(5000);
  const bounded = boundResult(longText, 10, 500);
  results.push({
    law: 4,
    name: 'bound_result',
    pass: bounded.spilled && bounded.text.length <= 500 && bounded.hash.length === 64,
  });

  // Law 3: budget_check
  const check = budgetCheck(7, 8);
  results.push({
    law: 3,
    name: 'budget_check_reserve',
    pass: check.reserveHit === true && check.warnings.length > 0,
  });

  const earlyCheck = budgetCheck(1, 8);
  results.push({
    law: 3,
    name: 'budget_check_early',
    pass: earlyCheck.reserveHit === false && earlyCheck.canRead === true,
  });

  // Law 1: compaction
  const fakeHistory = [];
  for (let i = 0; i < 10; i++) {
    fakeHistory.push({ role: 'user', content: 'x'.repeat(500) });
    fakeHistory.push({ role: 'assistant', content: 'y'.repeat(500) });
  }
  const compacted = compactHistory(fakeHistory, { threshold: 2000, keepRecent: 2 });
  results.push({
    law: 1,
    name: 'compaction',
    pass: compacted.compacted === true && compacted.exchangesKept === 2,
  });

  // Law 2: salvage
  const salvage = salvageOnCrash('test-run', [{ role: 'user', content: 'hello' }], new Error('test error'));
  results.push({
    law: 2,
    name: 'salvage_on_crash',
    pass: salvage.saved === true,
  });

  // Law 4: seal
  const seal = sealToolResult('test_tool', { a: 1 }, { ok: true }, 42);
  results.push({
    law: 4,
    name: 'anti_invention_seal',
    pass: seal.hash.length === 32 && seal.duration_ms === 42,
  });

  // Law 5: skill cap
  const capped = enforceSkillCap(['a', 'b', 'c', 'd'], 2);
  results.push({
    law: 5,
    name: 'skill_cap',
    pass: capped.capped === true && capped.skills.length === 2 && capped.dropped.length === 2,
  });

  const allPass = results.every(r => r.pass);
  return { pass: allPass, results };
}
