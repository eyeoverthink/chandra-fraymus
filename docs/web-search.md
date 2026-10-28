# Public source discovery

`web.search` sends one approved query to the fixed DuckDuckGo Lite HTTPS endpoint.
The approval preview shows the complete canonical query, provider and encoded
request URL. Search queries leave the device even when language-model inference
is local and paid cloud inference is disabled. Do not include private material
unless sending that exact query to that provider is intended.

No API key or paid search service is used. This is an adapter to the provider's
documented non-JavaScript interface, not a supported search API contract. Markup,
availability and ranking can change; challenges, unfamiliar layouts, redirects
and HTTP errors return an explicit failure. The tool does not solve challenges,
spoof a browser, retry automatically or switch endpoints/providers.

## What a receipt proves

Results retain the query/provider, timestamp, ordered titles, snippets,
destinations, stable link IDs and search-snapshot line ranges. The original
response hash and a separately hashed local snapshot bind those references to
the received response. Ranks express provider ordering, not credibility.
Snippets are untrusted provider previews, not full destination-page evidence.

Search only requests the result-list page. It does not fetch result destinations,
execute JavaScript, send cookies or use browser login state. The UI inserts no
result HTML, favicons or thumbnails and opens links only when clicked.

`web.results` paginates the retained ranked list without another network request.
`web.read`, `web.find` and `web.links` also work on that search snapshot. To read a
destination, call `web.follow` with its source/link ID. That requires a separate
approval of the exact resolved URL and rechecks DNS/public-network policy. Its
preview preserves the parent query, provider, rank and snapshot fingerprint.

## Limits

| Item | Limit |
|---|---|
| Query | 1–256 characters after trimming; no control characters |
| Retained results | At most 10 from the first provider page |
| Title / snippet / URL | 200 / 500 / 2,048 characters |
| Search concurrency | One; other searches fail as busy without a request |
| Minimum interval | Three seconds per service instance |
| HTTP 429 cooldown | At least 60 seconds, bounded Retry-After up to 24 hours |
| Response / parsing | Existing 1 MiB response, 3-second parser deadline and worker heap limits |
| Retention / access | Existing 16-source/run and storage quotas; current-run access only |

Each result response fits the run's tool-result budget and provides `nextOffset`
when more retained results remain. Empty provider results, limited retained
results, exhausted pages and failed searches remain distinct. No claim of
complete web coverage or relevance is implied.

Requests use the existing public-network boundary: all DNS answers must be
public, connections pin a checked address, TLS verification stays enabled,
environment proxies/ambient credentials are not used, and redirects require a
new explicit action. Search parsing runs in the existing bounded inert worker;
its links are not requested during parsing.

Search does not add a rendered browser, login session, form submission, desktop
clicks or an unattended computer agent. Those remain separate capabilities with
their own isolation and action-approval requirements. Arbitrary code execution
still requires the configured Docker sandbox.

Provider reference: [DuckDuckGo's documented non-JavaScript versions](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript).
