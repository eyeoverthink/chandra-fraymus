/**
 * Tool selection + approval normalisation for the fleet run loop.
 *
 * The registry may hold every tool the server has (~250). A local 8B model cannot be handed 250 JSON
 * schemas per request — the prompt overflows and the task is truncated — so each run is OFFERED the
 * most relevant few. Being offered is not the permission boundary: callTool() still executes any
 * registered tool the agent's manifest allows; this only decides which schemas ride in the prompt.
 */

/** Tools label risk four ways across the codebase; anything that asks for approval gets it. */
export function needsApproval(tool) {
  return !!tool && (tool.risk === 'approval' || tool.risk === 'approval_required' || tool.safety === 'approval_required');
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'use', 'using', 'tool', 'tools', 'then', 'into', 'have', 'what', 'will', 'are', 'was', 'not', 'now', 'run', 'get', 'all', 'any', 'its', 'can']);
const words = s => (String(s || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter(w => !STOP.has(w));

/**
 * Pick at most `max` tools for one run. Order of preference:
 *   1. tools the task names outright (by full name or by every part of the name)
 *   2. keyword overlap between the task and the tool's name (×3) and description (×1)
 *   3. `pinned` names (e.g. tools the manifest lists explicitly) and for-all-agents skill tools
 * Deterministic: ties keep registry order. Returns the input untouched when it already fits.
 */
export function selectToolsForRun(tools, task, { max = 24, pinned = [] } = {}) {
  if (!Array.isArray(tools) || tools.length <= max) return tools || [];
  const text = String(task || '').toLowerCase();
  const taskWords = new Set(words(text));
  const pin = new Set(pinned);
  const scored = tools.map((t, i) => {
    const nameParts = words(t.name.replace(/[._-]+/g, ' '));
    let score = 0;
    if (text.includes(t.name.toLowerCase())) score += 100;
    else if (nameParts.length > 1 && nameParts.every(p => taskWords.has(p))) score += 40;
    for (const p of nameParts) if (taskWords.has(p)) score += 3;
    const seen = new Set();
    for (const w of words(t.description).slice(0, 80)) if (taskWords.has(w) && !seen.has(w)) { seen.add(w); score += 1; }
    if (pin.has(t.name)) score += 6;
    if (t.group === 'skill' && t.forAllAgents) score += 4;
    return { t, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, max).sort((a, b) => a.i - b.i).map(s => s.t);
}
