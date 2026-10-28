import { fail } from './schema.js';

export const DEFAULT_AGENT_BUDGET = Object.freeze({ maxSteps: 8, maxToolCalls: 12, maxInputTokens: 16384,
  maxOutputTokens: 2048, maxTotalTokens: 24000, maxDurationMs: 180000, maxToolResultChars: 12000,
  maxOutputChars: 32000, maxCostUsd: 0 });
export const DEFAULT_TASK_BUDGET = Object.freeze({ ...DEFAULT_AGENT_BUDGET, maxDurationMs: 300000 });
export const AGENT_BUDGET_LIMITS = Object.freeze(Object.fromEntries(Object.entries({ maxSteps: [1, 32],
  maxToolCalls: [0, 32], maxInputTokens: [1024, 32768], maxOutputTokens: [1, 8192],
  maxTotalTokens: [1, 200000], maxDurationMs: [100, 600000], maxToolResultChars: [256, 32000],
  maxOutputChars: [1, 128000], maxCostUsd: [0, 100] }).map(([key, range]) => [key, Object.freeze(range)])));

export function normalizeAgentBudget(input, { defaults = DEFAULT_AGENT_BUDGET, localOnly = false } = {}) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) fail('invalid_budget', 'budget must be an object');
  const budget = { ...defaults };
  for (const [key, value] of Object.entries(input || {})) {
    const range = Object.hasOwn(AGENT_BUDGET_LIMITS, key) ? AGENT_BUDGET_LIMITS[key] : null;
    if (!range || !Number.isFinite(value) || (key !== 'maxCostUsd' && !Number.isInteger(value)) || value < range[0] || value > range[1]) fail('invalid_budget', `Invalid budget.${key}`);
    budget[key] = value;
  }
  if (localOnly && budget.maxCostUsd !== 0) fail('invalid_budget', 'Local scheduled tasks require maxCostUsd:0');
  return budget;
}
