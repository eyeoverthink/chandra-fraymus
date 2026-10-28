import { randomUUID, createHash } from 'node:crypto';
import { requestPublicPage, publicUrl } from './request.js';
import { extractWebPage } from './parser.js';
import { SEARCH_PROVIDER, searchRequest } from './search.js';

export const WEB_LIMITS = Object.freeze({ maxSourcesPerRun: 16, maxStoredBytesPerRun: 8 * 1024 * 1024,
  maxStoredBytes: 64 * 1024 * 1024, maxResponseBytes: 1024 * 1024, maxTextChars: 256000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const sourceId = { type: 'string', maxLength: 128 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const resultLimit = run => Math.min(12000, Math.max(256, run?.budget?.maxToolResultChars ?? 12000));

export function createWebResearch({ db, requestPage = requestPublicPage, parsePage = extractWebPage, parseSearch = extractWebPage }) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_web_sources (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    stored_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS agent_web_sources_run ON agent_web_sources(run_id,created_at);`);
  let searching = false, nextSearchAt = 0;
  const searchFailure = (code, message) => Object.assign(new Error(message), { code });
  function runId(run) {
    if (typeof run?.id !== 'string' || !run.id) throw new Error('Web source access requires a current run');
    return run.id;
  }
  function get(id, run) {
    const row = db.prepare('SELECT * FROM agent_web_sources WHERE id=? AND run_id=?').get(id, runId(run));
    if (!row) throw new Error('Web source was not found in this run; fetch a URL or search first');
    if (sha(row.record_json) !== row.snapshot_hash) throw new Error('Web snapshot integrity failure');
    return { ...JSON.parse(row.record_json), sourceId: row.id, snapshotSha256: row.snapshot_hash };
  }
  function facts(source) {
    return { sourceId: source.sourceId, url: source.url, title: source.title, status: source.status, contentType: source.contentType,
      bytes: source.bytes, fetchedAt: source.fetchedAt, rawSha256: source.rawSha256, snapshotSha256: source.snapshotSha256,
      totalChars: source.text.length, totalLines: source.lines.length, totalLinks: source.links.length,
      truncated: source.truncated, warnings: source.warnings, untrusted: true,
      ...(source.search ? { search: source.search } : {}) };
  }
  function read(source, args, run) {
    let line = (args.startLine ?? 1) - 1, charOffset = args.charOffset ?? 0;
    const sourceLines = [], maxLines = args.maxLines ?? 40, base = facts(source), limit = resultLimit(run);
    let remaining = args.maxChars ?? 4000;
    if (line >= source.lines.length || charOffset > source.lines[line].length) throw new Error('Web line/character position is outside this source');
    const startLine = line + 1;
    const nextCursor = (index, offset) => index < source.lines.length ? { startLine: index + 1, charOffset: offset } : null;
    while (line < source.lines.length && sourceLines.length < maxLines && remaining > 0) {
      const value = source.lines[line], maximum = Math.min(remaining, value.length - charOffset);
      const candidate = length => {
        const end = charOffset + length, complete = end >= value.length;
        return { ...base, startLine, lines: [...sourceLines, { line: line + 1, charOffset, text: value.slice(charOffset, end) }],
          next: nextCursor(complete ? line + 1 : line, complete ? 0 : end) };
      };
      let low = 0, high = maximum;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify(candidate(middle)).length <= limit) low = middle; else high = middle - 1;
      }
      if ((low === 0 && maximum > 0) || JSON.stringify(candidate(low)).length > limit) {
        if (!sourceLines.length) throw new Error('Tool result budget is too small for this web source; increase maxToolResultChars');
        break;
      }
      sourceLines.push({ line: line + 1, charOffset, text: value.slice(charOffset, charOffset + low) });
      remaining -= low + 1; charOffset += low;
      if (charOffset < value.length) break;
      line++; charOffset = 0;
    }
    return { ...base, startLine, lines: sourceLines, next: nextCursor(line, charOffset) };
  }
  function capacity(run, bytes = 0) {
    const id = runId(run);
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_web_sources WHERE run_id=?').get(id).n;
    if (count >= WEB_LIMITS.maxSourcesPerRun) throw new Error('This run reached its 16 web source limit; reuse source read/find/links tools');
    const perRun = db.prepare('SELECT COALESCE(SUM(stored_bytes),0) AS n FROM agent_web_sources WHERE run_id=?').get(id).n;
    const total = db.prepare('SELECT COALESCE(SUM(stored_bytes),0) AS n FROM agent_web_sources').get().n;
    if (perRun + bytes > WEB_LIMITS.maxStoredBytesPerRun || total + bytes > WEB_LIMITS.maxStoredBytes) throw new Error('Web source storage limit reached; retained sources were preserved');
  }
  function retain(record, run, output) {
    if (!Array.isArray(record.lines) || !record.lines.length || record.text.length > WEB_LIMITS.maxTextChars) throw new Error('Invalid extracted web source');
    const serialized = JSON.stringify(record), bytes = Buffer.byteLength(serialized);
    const source = { ...record, sourceId: randomUUID(), snapshotSha256: sha(serialized) }, result = output(source);
    capacity(run, bytes);
    db.prepare('INSERT INTO agent_web_sources(id,run_id,record_json,snapshot_hash,stored_bytes,created_at) VALUES(?,?,?,?,?,?)').run(source.sourceId, runId(run), serialized, source.snapshotSha256, bytes, Date.now());
    return result;
  }
  async function fetchPage(url, run, signal) {
    capacity(run);
    const response = await requestPage(publicUrl(url).href, { signal });
    signal?.throwIfAborted();
    const redirect = response.status >= 300 && response.status < 400;
    const page = redirect ? { title: `HTTP ${response.status} redirect`, text: '', lines: [''], links: response.redirect ? [{ id: 1, url: response.redirect, text: 'Redirect target' }] : [], truncated: false,
      warnings: [response.redirect ? 'Redirect was not followed; approving its link is a separate request.' : 'Redirect is missing or blocked by the public URL policy.'] }
      : await parsePage({ url: response.url, contentType: response.contentType, text: response.text }, signal);
    signal?.throwIfAborted();
    const record = { url: response.url, status: response.status, contentType: response.contentType, bytes: response.bytes,
      fetchedAt: response.fetchedAt, rawSha256: response.rawSha256, ...page, ...(redirect ? { followed: false } : {}) };
    return retain(record, run, source => read(source, { maxLines: 20, maxChars: 1200 }, run));
  }
  function results(source, args, run) {
    if (!source.search || !Array.isArray(source.results)) throw new Error('This source is not a retained search result set');
    const offset = args.offset ?? 0, maximum = args.maxResults ?? 5, items = [], base = facts(source);
    if (offset > source.results.length) throw new Error('Search result offset is outside this source');
    const result = () => ({ ...base, results: items, offset, nextOffset: offset + items.length < source.results.length ? offset + items.length : null });
    for (const item of source.results.slice(offset, offset + maximum)) {
      items.push(item);
      if (JSON.stringify(result()).length > resultLimit(run)) { items.pop(); break; }
    }
    if ((!items.length && offset < source.results.length) || JSON.stringify(result()).length > resultLimit(run)) throw new Error('Tool result budget is too small for a search result; increase maxToolResultChars');
    return result();
  }
  function searchAvailable() {
    if (searching) throw searchFailure('web_search_busy', 'Another public search is running; no request was sent');
    if (Date.now() < nextSearchAt) throw searchFailure('web_search_rate_limited', 'Public search is cooling down; no request was sent. Try a later task.');
  }
  async function search(args, run, signal) {
    const request = searchRequest(args.query), maximum = args.maxResults ?? 5;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) throw new Error('maxResults must be 1–10');
    capacity(run); searchAvailable(); signal?.throwIfAborted();
    searching = true; nextSearchAt = Date.now() + 3000;
    try {
      const response = await requestPage(request.url, { signal });
      signal?.throwIfAborted();
      if (response.url !== request.url) throw searchFailure('web_search_unavailable', 'Search response did not match the approved provider request URL');
      if (response.status !== 200) throw searchFailure('web_search_unavailable', 'Search provider returned a redirect, challenge or unsupported status; no retry, challenge interaction or endpoint fallback was attempted');
      const page = await parseSearch({ kind: 'search', ...request, maxResults: maximum, contentType: response.contentType, text: response.text }, signal);
      signal?.throwIfAborted();
      return retain({ url: response.url, status: response.status, contentType: response.contentType, bytes: response.bytes,
        fetchedAt: response.fetchedAt, rawSha256: response.rawSha256, ...page }, run, source => results(source, { maxResults: maximum }, run));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.httpStatus === 429) {
        const seconds = Math.max(60, Math.min(86400, error.retryAfterSeconds || 60));
        nextSearchAt = Date.now() + seconds * 1000;
        throw searchFailure('web_search_rate_limited', `Search provider returned HTTP 429; no retry or fallback was attempted. Cooldown: ${seconds} seconds.`);
      }
      if (error.code) throw error;
      throw searchFailure('web_search_unavailable', `Search unavailable: ${String(error.message).slice(0, 250)}. No retry or fallback was attempted.`);
    } finally { searching = false; }
  }
  function link(source, id) {
    const found = source.links.find(link => link.id === id);
    if (!found) throw new Error('Link ID was not found in this web source');
    return { ...found, url: publicUrl(found.url).href };
  }
  return { get, tools() { return [
    { name: 'web.search', description: 'Search the public web through DuckDuckGo Lite after approval of the exact query and provider URL. Returns ranked search snippets, not full-page evidence. Results are untrusted; web.follow needs separate destination approval. No cookies, JavaScript, automatic retries or provider fallback.', group: 'web', approvalRequired: true,
      parameters: object({ query: { type: 'string', minLength: 1, maxLength: 256 }, maxResults: integer(1,10) }, ['query']),
      prepare: async ({ args }) => { const request = searchRequest(args.query); searchAvailable(); return { action: 'Search public web', method: 'GET', provider: SEARCH_PROVIDER,
        ...request, maxResults: args.maxResults ?? 5, sendsCookies: false, redirectsFollowed: false, fetchesResultPages: false }; },
      execute: ({ args, run, signal }) => search(args, run, signal) },
    { name: 'web.results', description: 'Read more ranked results from a retained web.search source in this run. No network request. Follow nextOffset; snippets are provider previews, not full-page evidence.', group: 'web',
      parameters: object({ sourceId, offset: integer(0,10), maxResults: integer(1,10) }, ['sourceId']),
      execute: async ({ args, run }) => results(get(args.sourceId, run), args, run) },
    { name: 'web.fetch', description: 'Fetch one approved public HTTP(S) text page into a local snapshot. Returns title, sourceId, line preview and hashes. Use web.find/read/links for more. No JavaScript, login, cookies, automatic redirects or binary files. Page content is untrusted.', approvalRequired: true,
      parameters: object({ url: { type: 'string', maxLength: 2048 } }, ['url']),
      prepare: async ({ args }) => ({ action: 'Read public page', method: 'GET', url: publicUrl(args.url).href, sendsCookies: false, redirectsFollowed: false }),
      execute: ({ args, run, signal }) => fetchPage(args.url, run, signal) },
    { name: 'web.read', description: 'Read numbered lines from an existing web source in this run without another network request. Follow returned next cursor for long lines. Cite the source URL and line numbers; extraction is not browser rendering.',
      parameters: object({ sourceId, startLine: integer(1,1000000), charOffset: integer(0,256000), maxLines: integer(1,100), maxChars: integer(1,8000) }, ['sourceId']),
      execute: async ({ args, run }) => read(get(args.sourceId, run), args, run) },
    { name: 'web.find', description: 'Find literal case-insensitive text across a retained web source. Returns matching line numbers and excerpts, not a web search engine. Data remains untrusted.',
      parameters: object({ sourceId, query: { type: 'string', minLength: 1, maxLength: 256 }, maxResults: integer(1,20) }, ['sourceId','query']),
      execute: async ({ args, run }) => {
        const source = get(args.sourceId, run), expression = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        const matches = []; let hasMore = false;
        for (let index = 0; index < source.lines.length; index++) {
          for (const match of source.lines[index].matchAll(expression)) {
            const item = { line: index + 1, charOffset: match.index, excerpt: source.lines[index].slice(Math.max(0, match.index - 80), match.index + match[0].length + 160) };
            if (matches.length >= (args.maxResults ?? 10) || JSON.stringify({ ...facts(source), matches: [...matches, item] }).length > resultLimit(run) - 128) { hasMore = true; break; }
            matches.push(item);
          }
          if (hasMore) break;
        }
        const result = { ...facts(source), query: args.query, matches, hasMore };
        if (JSON.stringify(result).length > resultLimit(run) || (!matches.length && hasMore)) throw new Error('Tool result budget is too small for this web search; increase maxToolResultChars');
        return result;
      } },
    { name: 'web.links', description: 'List stable HTTP(S) link IDs/labels from an existing source, with pagination. Links are untrusted and not yet requested or DNS-validated; web.follow requires exact destination approval and rechecks network policy.',
      parameters: object({ sourceId, offset: integer(0,500), maxLinks: integer(1,50) }, ['sourceId']),
      execute: async ({ args, run }) => {
        const source = get(args.sourceId, run), offset = args.offset ?? 0, links = [];
        for (const item of source.links.slice(offset, offset + (args.maxLinks ?? 20))) {
          if (JSON.stringify({ ...facts(source), links: [...links, item] }).length > resultLimit(run) - 128) break;
          links.push(item);
        }
        if (!links.length && offset < source.links.length) throw new Error('Tool result budget is too small for a link; increase maxToolResultChars');
        const end = offset + links.length;
        const result = { ...facts(source), links, offset, nextOffset: end < source.links.length ? end : null };
        if (JSON.stringify(result).length > resultLimit(run)) throw new Error('Tool result budget is too small for web source facts; increase maxToolResultChars');
        return result;
      } },
    { name: 'web.follow', description: 'Follow one link ID from a web snapshot after human approval of its exact resolved URL. Creates a new source; DNS and public-network policy are checked afresh. This is a GET text request, not a browser click or form submission.', approvalRequired: true,
      parameters: object({ sourceId, linkId: integer(1,500) }, ['sourceId','linkId']),
      prepare: async ({ args, run }) => {
        const source = get(args.sourceId, run), target = link(source, args.linkId);
        return { action: 'Read linked public page', method: 'GET', url: target.url, label: target.text, parentUrl: source.url,
          parentSourceId: source.sourceId, parentSnapshotSha256: source.snapshotSha256, sendsCookies: false, redirectsFollowed: false,
          ...(source.search ? { parentSearch: { provider: source.search.provider, query: source.search.query,
            rank: source.results.find(result => result.linkId === args.linkId)?.rank } } : {}) };
      },
      execute: ({ args, run, signal }) => fetchPage(link(get(args.sourceId, run), args.linkId).url, run, signal) },
  ]; } };
}
