import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_PROVIDER, searchRequest, extractSearchPage } from '../server/web/search.js';

const query = 'CTranslate2 Windows installation';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const wrapper = value => '//duckduckgo.com/l/?uddg=' + encodeURIComponent(value) + '&rut=fixture';
const row = (rank, title = `Result ${rank}`, url = `https://example.org/page/${rank}`, snippet = `Snippet ${rank}`) => `<tr><td>${rank}.&nbsp;</td><td><a class="result-link" href="${escape(url)}">${title}</a></td></tr><tr><td></td><td class="result-snippet">${snippet}</td></tr><tr><td></td><td><span class="link-text">display URL is not authoritative</span></td></tr>`;
const page = (body, search = query) => `<!doctype html><html><head><title>Provider page</title></head><body><form action="/lite/" method="post"><input name="q" value="${escape(search)}"></form><table>${body}</table></body></html>`;
const parse = (text, options = {}) => extractSearchPage({ ...searchRequest(query), contentType: 'text/html; charset=UTF-8', text, ...options });
const empty = '<tr><td colspan="2"><div class="no-results__container"><span class="no-results"><div class="no-results__message"><h1>No results found for <strong>fixture query</strong></h1><p>Try related keywords</p></div></span></div></td></tr>';

test('fixed provider request trims/encodes only the exact query and rejects controls or malformed input', () => {
  assert.deepEqual(SEARCH_PROVIDER, { id: 'duckduckgo-lite', label: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/' });
  assert.ok(Object.isFrozen(SEARCH_PROVIDER));
  const result = searchRequest('  unicode café &q=other !bang  ');
  assert.equal(result.query, 'unicode café &q=other !bang');
  assert.equal(new URL(result.url).origin, 'https://lite.duckduckgo.com');
  assert.deepEqual([...new URL(result.url).searchParams], [['q', result.query]]);
  assert.equal(searchRequest('x'.repeat(256)).query.length, 256);
  for (const value of [undefined, null, 4, {}, '', '   ', 'x'.repeat(257), 'test\n', 'a\0b', 'a\x85b', 'a\u2028b', '\uD800']) assert.throws(() => searchRequest(value), { code: 'search_query_invalid' });
});

test('observed Lite table structure yields decoded destinations, associated snippets and stable source lines', () => {
  const result = parse(page(row(1, 'Official <b>installation</b> &amp; setup', wrapper('https://opennmt.net/CTranslate2/installation.html#part'), 'Read <b>Windows</b> requirements.') + row(2)));
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.links[0], { id: 1, url: 'https://opennmt.net/CTranslate2/installation.html', text: 'Official installation & setup' });
  assert.equal(result.results[0].snippet, 'Read Windows requirements.');
  assert.equal(result.search.provider.id, 'duckduckgo-lite');
  assert.equal(result.search.query, query);
  assert.equal(result.search.resultCount, 2);
  assert.equal(result.search.resultsLimited, false);
  for (const item of result.results) {
    assert.equal(item.linkId, result.links.find(link => link.url === item.url).id);
    const citation = result.lines.slice(item.startLine - 1, item.endLine).join('\n');
    assert.ok(citation.includes(item.title)); assert.ok(citation.includes(item.url)); assert.ok(citation.includes(item.snippet));
  }
  assert.equal(result.text, result.lines.join('\n'));
  assert.deepEqual(parse(page(row(1) + row(2))).results.map(item => item.linkId), [1, 2]);
});

test('markup is inert, hidden/embedded content is omitted and captcha words in real results are ordinary text', () => {
  const result = parse(page(row(1, 'Captcha <span hidden>SECRET</span> support<script>SECRET</script><svg><text>SECRET</text></svg>', wrapper('https://example.org/captcha'), 'Known <span aria-hidden="true">SECRET</span><span style="display:none">SECRET</span><b>captcha</b> documentation.')));
  assert.equal(result.results[0].title, 'Captcha support');
  assert.equal(result.results[0].snippet, 'Known captcha documentation.');
  assert.ok(!result.text.includes('SECRET'));
});

test('safe destination syntax, exact one-pass wrapper decoding and canonical deduplication are enforced', () => {
  const result = parse(page(row(1, 'One', wrapper('https://example.org/same#one')) + row(2, 'Duplicate', 'https://EXAMPLE.org/same#two')
    + row(3, 'Local', wrapper('http://127.0.0.1/private')) + row(4, 'Credentials', 'https://user:pass@example.org/')
    + row(5, 'Script', 'javascript:alert(1)') + row(6, 'Encoded again', '//duckduckgo.com/l/?uddg=https%253A%252F%252Fexample.org')
    + row(7, 'Duplicated uddg', '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org&uddg=https%3A%2F%2Fevil.example')
    + row(8, 'Internal', 'https://duckduckgo.com/y.js?ad=1') + row(9, 'Port', 'https://example.org:8443/')
    + row(10, 'Two', 'http://example.net/allowed')));
  assert.deepEqual(result.results.map(item => [item.rank, item.linkId, item.url]), [[1, 1, 'https://example.org/same'], [10, 2, 'http://example.net/allowed']]);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some(value => value.includes('duplicate')));
  assert.throws(() => parse(page(row(1, 'Unsafe', 'file:///C:/private'))), { code: 'search_no_safe_results' });
});

test('maxResults, hard ten-result cap, title/snippet bounds and well-formed Unicode omissions are explicit', () => {
  const html = page(Array.from({ length: 12 }, (_, index) => row(index + 1, 'A'.repeat(199) + '🌍B', wrapper(`https://example.org/${index}`), 'S'.repeat(499) + '🌍Z')).join(''));
  const limited = parse(html, { maxResults: 3 });
  assert.equal(limited.results.length, 3); assert.equal(limited.search.maxResults, 3); assert.equal(limited.search.resultsLimited, true);
  assert.equal(limited.results[0].title.length, 199); assert.equal(limited.results[0].snippet.length, 499);
  assert.ok(limited.results.every(item => item.title.isWellFormed() && item.snippet.isWellFormed()));
  assert.equal(parse(html, { maxResults: 10 }).results.length, 10);
  assert.equal(limited.truncated, true);
  assert.ok(limited.warnings.some(value => value.includes('200/500')));
  const longUrl = 'https://example.org/' + 'x'.repeat(2048);
  assert.equal(parse(page(row(1, 'Too long', longUrl) + row(2))).results.length, 1);
  assert.equal(parse(page(row(1, 'Serialized too long', 'https://example.org/' + 'é'.repeat(1000)) + row(2))).results.length, 1);
  for (const value of [0, 11, 1.5, '3', null]) assert.throws(() => parse(html, { maxResults: value }), { code: 'search_input_invalid' });
});

test('structural challenges fail closed even when a page also contains otherwise valid results', () => {
  for (const challenge of ['<form id="challenge-form"></form>', '<form id="img-form"></form>', '<div class="anomaly-modal__mask">Human check</div>', '<form action="//duckduckgo.com/anomaly.js?x=1"></form>']) {
    assert.throws(() => parse(page(row(1)) + challenge), { code: 'search_blocked' });
  }
});

test('only recognized provider empty state succeeds; an absent/changed result layout never pretends zero results', () => {
  const result = parse(page(empty));
  assert.deepEqual(result.results, []); assert.deepEqual(result.links, []);
  assert.equal(result.search.resultCount, 0); assert.equal(result.search.resultsLimited, false);
  assert.ok(result.text.includes('explicitly reported no results'));
  for (const body of ['', '<p>No results found</p>', '<h1>Service unavailable</h1>', empty + row(1), '<tr><td><a class="result-link" href="https://example.org/">Changed layout</a></td></tr>']) assert.throws(() => parse(page(body)), { code: 'search_layout_changed' });
  assert.throws(() => parse(page(row(1), 'Different query')), { code: 'search_layout_changed' });
  assert.throws(() => parse(page(row(1)).replace('method="post"', 'method="get"')), { code: 'search_layout_changed' });
});

test('sponsored rows are omitted and snippets cannot silently migrate across result table boundaries', () => {
  const ad = row('Ad', 'Sponsored fixture', 'https://example.org/ad');
  const result = parse(page(ad + row(1)));
  assert.equal(result.results.length, 1); assert.equal(result.results[0].rank, 1);
  assert.equal(result.results[0].snippet, 'Snippet 1');
  assert.ok(result.warnings.some(value => value.includes('sponsored')));
  const crossed = page(row(1).replace(/<tr><td><\/td><td class="result-snippet">[\s\S]*?<\/td><\/tr>/, ''))
    .replace('</body>', '<table><tr><td class="result-snippet">Unrelated table text</td></tr></table></body>');
  assert.throws(() => parse(crossed), { code: 'search_layout_changed' });
});

test('input URL/query binding, byte/content-type limits and DOM node/depth bounds are independent of transport', () => {
  const html = page(row(1));
  for (const url of ['https://html.duckduckgo.com/html/?q=x', SEARCH_PROVIDER.url, searchRequest(query).url + '&q=other', searchRequest(query).url + '#fragment']) assert.throws(() => parse(html, { url }), { code: 'search_input_invalid' });
  for (const contentType of ['text/plain', 'application/json', 'image/png']) assert.throws(() => parse(html, { contentType }), { code: 'search_input_invalid' });
  assert.throws(() => parse('é'.repeat(512 * 1024 + 1)), { code: 'search_input_invalid' });
  assert.throws(() => parse('\uD800'), { code: 'search_input_invalid' });
  assert.throws(() => parse(page('<div>'.repeat(260) + '</div>'.repeat(260) + row(1))), { code: 'search_parse_limit' });
  assert.throws(() => parse(page('<i></i>'.repeat(50000) + row(1))), { code: 'search_parse_limit' });
});
