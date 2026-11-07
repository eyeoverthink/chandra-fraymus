import { randomUUID } from 'node:crypto';

export function createTelemetry(db) {
  const insert = db.prepare(`INSERT INTO fraymus_os_requests (
    id, kind, endpoint, route_class, model, bytes_sent, bytes_received,
    tokens_in, tokens_out, eval_duration_ns, duration_ms, ok, error, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function record(entry) {
    const bytesSent = Number.isFinite(entry.bytesSent) ? entry.bytesSent : 0;
    insert.run(
      entry.id || randomUUID(),
      entry.kind || 'request',
      entry.endpoint || null,
      entry.routeClass || 'invalid',
      entry.model || null,
      bytesSent,
      Number.isFinite(entry.bytesReceived) ? entry.bytesReceived : null,
      Number.isFinite(entry.tokensIn) ? entry.tokensIn : null,
      Number.isFinite(entry.tokensOut) ? entry.tokensOut : null,
      Number.isFinite(entry.evalDurationNs) ? entry.evalDurationNs : null,
      Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
      entry.ok ? 1 : 0,
      entry.error || null,
      Date.now(),
    );
  }

  function list(limit = 50) {
    const capped = Math.min(200, Math.max(1, limit));
    return db.prepare(`SELECT id, kind, endpoint, route_class AS routeClass, model,
      bytes_sent AS bytesSent, bytes_received AS bytesReceived,
      tokens_in AS tokensIn, tokens_out AS tokensOut,
      eval_duration_ns AS evalDurationNs, duration_ms AS durationMs,
      ok, error, created_at AS createdAt
      FROM fraymus_os_requests ORDER BY created_at DESC LIMIT ?`).all(capped);
  }

  function summary() {
      const rows = db.prepare(`SELECT route_class, bytes_sent, tokens_in, tokens_out, eval_duration_ns, duration_ms, error
      FROM fraymus_os_requests`).all();
    const bytesSent = { local: 0, private: 0, public: 0, other: 0 };
    const calls = { local: 0, private: 0, public: 0, other: 0 };
    let blockedPublic = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let sawTokens = false;
    let tokenSeconds = 0;
    let tokenWeight = 0;
    for (const row of rows) {
      if (row.error === 'public_cloud_disabled') {
        blockedPublic += 1;
        continue;
      }
      const bucket = ['local', 'private', 'public'].includes(row.route_class) ? row.route_class : 'other';
      calls[bucket] += 1;
      bytesSent[bucket] += row.bytes_sent || 0;
      if (row.tokens_in != null || row.tokens_out != null) {
        sawTokens = true;
        tokensIn += row.tokens_in || 0;
        tokensOut += row.tokens_out || 0;
      }
      if (row.tokens_out != null) {
        if (row.eval_duration_ns > 0) {
          tokenSeconds += row.eval_duration_ns / 1e9;
          tokenWeight += row.tokens_out;
        } else if (row.duration_ms > 0) {
          tokenSeconds += row.duration_ms / 1000;
          tokenWeight += row.tokens_out;
        }
      }
    }
    return {
      localCalls: calls.local,
      privateCalls: calls.private,
      publicCalls: calls.public,
      blockedPublicAttempts: blockedPublic,
      otherCalls: calls.other,
      bytesSent,
      dataSentBytes: bytesSent.local + bytesSent.private + bytesSent.public + bytesSent.other,
      tokensIn: sawTokens ? tokensIn : null,
      tokensOut: sawTokens ? tokensOut : null,
      tokensPerSec: tokenSeconds > 0 ? Math.round((tokenWeight / tokenSeconds) * 100) / 100 : null,
      tokensMeasured: sawTokens,
      requestCount: rows.length,
      measured: true,
    };
  }

  return { record, list, summary };
}
