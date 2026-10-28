# Public web research with retained source references

The local agent can fetch one approved public HTTP(S) text page, search the
retained page, read numbered lines, list its links, and follow an approved link.
This is an inert HTML/text reader. It is not a search engine, browser automation,
logged-in browsing, a form sender, or JavaScript rendering.

## Workflow

1. `web.fetch({url})` pauses for approval of the canonical GET destination. No DNS
   or HTTP lookup happens during its syntax-only preview. The result includes a
   short preview, source ID, timestamp, title, line/link counts and hashes.
2. `web.find({sourceId,query})` searches literal text within that retained source.
   Match line numbers and character offsets identify where to read next.
3. `web.read({sourceId,startLine,charOffset,maxLines,maxChars})` reads the snapshot
   without contacting the site again. Follow its `next` cursor for long lines.
4. `web.links({sourceId,offset,maxLinks})` lists source-provided HTTP(S) candidates
   with stable IDs. Listing a URL does not validate its DNS or approve a request.
5. `web.follow({sourceId,linkId})` pauses with the exact resolved destination and
   parent snapshot hash. Execution rechecks DNS and returns a new source.

Redirects become a source with an unfollowed target link, not another automatic
request. Missing, private-literal or unsupported redirect targets are blocked.
Every further hop needs its own approval. Source HTML, labels, titles, links and
tool output remain untrusted data and never grant authority.

Source IDs belong to one run. Reads in other runs fail. SQLite retains extracted
text/lines/links under `agent_web_sources` and hashes each serialized record.
`rawSha256` fingerprints downloaded bytes; those original bytes are not retained.
`snapshotSha256` fingerprints the retained extracted record. These are integrity
and provenance facts, not sender authentication. Host database access is trusted.

Citations should include the exact source URL and returned line references.
Numbers refer to this extraction snapshot, not the site's own published line
numbers. The companion shows recorded source facts, excerpts, hashes and follow
previews; opening an external link in the user's browser can show newer content.

## Network and parser limits

| Boundary | Enforced behavior |
|---|---|
| Destination | HTTP/HTTPS default ports, no userinfo; loopback/private/reserved address ranges rejected |
| DNS/dial | All answers must pass the public-address policy; one checked address is pinned to a fresh connection |
| Credentials | No cookies, authorization headers, browser profile or environment proxy |
| Transport | Certificate validation enabled; 16 KiB headers, 10 seconds including DNS wait, 1 MiB body |
| Encoding | Identity transfer only, declared charset validated; unsupported compression, binary, malformed or truncated responses fail |
| Parallelism | At most four in-flight network requests and two text parser workers |
| Parsing | Inert parse5 AST in a 128 MiB V8 worker with a three-second deadline |
| Extraction | 256,000 text units, 500 unique links, 200-unit labels, 2,048-unit URLs; omissions are explicit |
| Retention | 16 sources and 8 MiB serialized snapshots per run; 64 MiB total; full storage rejects new snapshots and preserves existing evidence |
| Results | Preview up to 1,200 text units; read up to 8,000; serialized results honor the run result cap up to 12,000 units |

Text positions use JavaScript UTF-16 units; transport/storage quotas use bytes.
Search/read results are scoped to retained text. Extraction omissions cannot be
recovered by advancing a cursor. External CSS, layout, images and dynamically
generated content are not evaluated. Scripts and embedded content are not run.
Workers are resource controls, not a general OS sandbox. No arbitrary page code
is passed to the code executor, and Docker availability does not affect this reader.

## Schema cost

Tool groups keep unused definitions out of the initial model context. Ungrouped
workspace/memory/code tools and `tools.enable` remain advertised; document, web
and transport groups activate from the original request or an explicit discovery
call. Appending newly activated definitions preserves provider tool aliases.
Enabling a group changes context only and cannot approve actions or change budgets.

The core default context cap is now 16,384, matching the companion. Explicit lower
caps remain enforced. Output, cumulative tokens, time, calls, steps and dollars
keep their existing limits. Measured schema-byte reductions are reported separately
from actual model token receipts; they are not tokenizer or intelligence gains.

Implementation references: [parse5](https://parse5.js.org/),
[Node HTTP client](https://nodejs.org/api/http.html),
[Node DNS lookup](https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options).
