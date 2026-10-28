// Agent presence detection + live chain verification
// Source: Library Manager presence.js

export function presenceStatus(agent, nowSec = Math.floor(Date.now() / 1000)) {
  if (!agent?.last_seen) return 'offline';
  const delta = nowSec - agent.last_seen;
  if (delta < 60) return 'online';
  if (delta < 300) return 'idle';
  return 'offline';
}

export function presenceColor(status) {
  switch (status) {
    case 'online': return '#22c55e';
    case 'idle': return '#eab308';
    default: return '#6b7280';
  }
}

export function isChainHealthy(chainResult) {
  return chainResult && chainResult.valid && chainResult.total > 0;
}
