// Ollama Response Sanitizer — Provider Output Boundary
// Wired into every chatOllama / provider return path.
// Per-request interceptor state; shared canary accumulator.
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

import { StreamCanaryInterceptor } from './stream-canary.js';
import { TriangulatedHoneypotArray } from './canary.js';

const sharedCanary = new TriangulatedHoneypotArray(48, 1.0, { minSamples: 10 });
let totalRequests = 0;
let totalRedactions = 0;
const recentAlerts = [];
const MAX_ALERTS = 100;

export function sanitizeOllamaContent(text) {
  if (!text || typeof text !== 'string') return text;
  totalRequests++;
  const interceptor = new StreamCanaryInterceptor(sharedCanary);
  const sanitized = interceptor.processToken(text, 0, true);
  if (interceptor.totalRedactions > 0) {
    totalRedactions += interceptor.totalRedactions;
    const alert = {
      timestamp: Date.now(),
      redactions: interceptor.totalRedactions,
      textLength: text.length,
    };
    recentAlerts.push(alert);
    if (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();
  }
  return sanitized;
}

export function getInterceptorStats() {
  return {
    totalRequests,
    totalRedactions,
    recentAlertCount: recentAlerts.length,
    recentAlerts: recentAlerts.slice(-10),
    canary: sharedCanary.toJSON(),
    triangulation: sharedCanary.triangulateFault(),
  };
}

export function resetInterceptorStats() {
  totalRequests = 0;
  totalRedactions = 0;
  recentAlerts.length = 0;
  sharedCanary.reset();
}

export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeOllamaContent(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

export default { sanitizeOllamaContent, sanitizeDeep, getInterceptorStats, resetInterceptorStats };
