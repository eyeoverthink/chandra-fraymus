export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text || response.statusText }; }
  if (!response.ok) {
    const error = new Error(body?.error || response.statusText);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatWhen(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return '—'; }
}

export const KIND_COLORS = {
  note: '#f5c16c',
  memory: '#3ee0ff',
  agent: '#c084fc',
  workflow: '#3ddc97',
  artifact: '#ff8a5b',
  skill: '#f472b6',
  file: '#94a3b8',
};
