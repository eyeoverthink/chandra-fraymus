/**
 * Narration guard — a reply that DESCRIBES a tool call is not a tool call.
 *
 * Small local models often write "Tool Response: { … }" with an invented result instead of emitting
 * a real call (first seen 2026-11-10: fraymus_prime "called" `reason` twice, reported 4211 for a sum
 * whose value is 4945, and the run ended 'done'). narratedToolCall() returns the name of the tool the
 * reply claims to have used when no call was made, so the run loop can refuse the invented evidence.
 */
const MARKERS = /tool\s+(?:call|response|output|result)|\btool\s+returns?\b|\b(?:input|output)\s*:\s*\{|"exitCode"\s*:/i;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MAX_NARRATION_NUDGES = 1;

/** tools: [{ name }]. Returns a tool name or null. Pure; safe to call on every final reply. */
export function narratedToolCall(content, tools) {
  const text = String(content || '');
  if (text.length < 20) return null;
  // a call written out as text — {"name": "x", "parameters": {…}} — reached no tool at all
  const inline = text.match(/\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{1,60})"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{/);
  if (inline) return inline[1];
  if (!MARKERS.test(text)) return null;
  for (const t of tools || []) {
    const n = escapeRe(t.name);
    // the name in backticks, "<name> tool", or "call/calling/called [the] <name>"
    if (new RegExp('`' + n + '`|\\b' + n + '\\s+tool\\b|\\bcall(?:ing|ed)?\\s+(?:the\\s+)?' + n + '\\b', 'i').test(text)) return t.name;
  }
  // A tool the agent was never given (the original case: the registry did not hold `reason` at all).
  // Only on the strong shape — a "Tool response/output" heading followed by a JSON body — and the
  // name it claims, so ordinary prose about tools is left alone.
  const fabricated = text.match(/tool\s+(?:response|output|result)\s*:?\**\s*[\s\S]{0,160}?[{[]\s*"/i);
  if (fabricated) { const named = text.match(/`([A-Za-z_][\w.-]{1,60})`\s+tool\b/); return named ? named[1] : 'unknown_tool'; }
  return null;
}

/**
 * Llama-family models often emit a well-formed call as TEXT — {"name": "tool", "parameters": {…}} —
 * instead of a structured tool_call. When the named tool is one the agent was actually offered and
 * the JSON parses, that is an unambiguous intent: return it as a real call so the loop executes it
 * (through the same approval and manifest gates as any other call) instead of scolding the model.
 * Returns { id, function: { name, arguments } } or null.
 */
export function recoverTextToolCall(content, tools) {
  const text = String(content || '');
  const start = text.search(/\{\s*"name"\s*:\s*"/);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  let call;
  try { call = JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
  if (!call || typeof call.name !== 'string' || !(tools || []).some(t => t.name === call.name)) return null;
  let args = call.parameters ?? call.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { id: `text_${Date.now().toString(36)}`, function: { name: call.name, arguments: args } };
}

const missingToolMessage =(tool, names) => `[harness] Your last message described a call to \`${tool}\`, but no shared tool has that name, so nothing ran and any result you wrote was invented. Tools attached now: ${names.slice(0, 40).join(', ') || '(none)'}. Use one of them, find another with tools.search, or say plainly that you cannot do this.`;
const unattachedToolMessage = tool => `[harness] Your last message described a call to \`${tool}\`, but no call was made, so any result you wrote was invented. \`${tool}\` is a shared tool that is not attached to this step: call tools.load with {"names": ["${tool}"]}, then make the real call.`;
/** tools (optional): the agent's real tools — when the claimed one is not among them, say so. */
export const nudgeMessage = (tool, tools = null, shared = null) => Array.isArray(tools) && !tools.some(t => t.name === tool)
  ? (Array.isArray(shared) && shared.some(t => t.name === tool) ? unattachedToolMessage(tool) : missingToolMessage(tool, tools.map(t => t.name)))
  :`[harness] Your last message described a call to \`${tool}\` but no tool call was made, so any result you wrote was invented and must not be used. Make the real ${tool} tool call now with its JSON arguments, or answer without claiming any tool output.`;
export const unverifiedMessage = tool => `[harness] The reply above describes output from \`${tool}\` that was never produced — no tool call was made in this run. Treat that result as unverified.`;
