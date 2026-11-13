/**
 * Tool selection + approval normalisation for the fleet run loop.
 *
 * The registry holds every tool the server shares (~360), and every agent may use any of them — shared tools,
 * skills and adaptations are the point of the app. A local 8–14B model cannot be handed 360 JSON schemas per
 * request (the prompt overflows and the task is truncated), so each run is OFFERED the most relevant few, and
 * the agent can find and attach any other with `tools.search` / `tools.load` (fleet/runtime.js). Being offered
 * is not a permission: safety comes from approvals, writ tiers and an explicit `permissions.deny`.
 */

/** Tools label risk four ways across the codebase; anything that asks for approval gets it. A tool whose effect
 *  depends on its arguments (shopper.audit only writes to the store with autoApply) declares `approvalWhen(args)`. */
export function needsApproval(tool, args = undefined) {
  if (!tool) return false;
  if (tool.risk === 'approval' || tool.risk === 'approval_required' || tool.safety === 'approval_required') return true;
  if (typeof tool.approvalWhen === 'function') {
    if (args === undefined) return true;   // unknown arguments: assume the effectful case
    try { return !!tool.approvalWhen(args || {}); } catch (e) { console.error('[tool-select] approvalWhen:', e.message); return true; }
  }
  return false;
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
  return rankTools(tools, task, { pinned }).slice(0, max).sort((a, b) => a.i - b.i).map(s => s.t);
}

/** Every tool scored against `text`, best first (ties in registry order): `[{ t, i, score }]`. Used by the
 *  per-run offer above and by the agents' own `tools.search`, so both rank the shared registry the same way. */
export function rankTools(tools, text, { pinned = [] } = {}) {
  text = String(text || '').toLowerCase();
  const taskWords = new Set(words(text));
  const pin = new Set(pinned);
  const scored = (tools || []).map((t, i) => {
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
  return scored.sort((a, b) => b.score - a.score || a.i - b.i);
}
