# PDF and ZIP reference documents

The partner attachment picker accepts PDF and ZIP alongside PNG/JPEG and UTF-8
text/Markdown/JSON. Four attachments, at most 4 MiB each, may accompany a run.
Parsing stays local; choosing an optional cloud model still sends the selected
excerpts/tool results to that provider under the existing explicit opt-in.

PDF.js extracts text with page references. This does not inspect page images,
layout, diagrams or handwriting, and performs no OCR. Textless pages are listed
explicitly; an empty page is not evidence of an empty document. Password-protected
PDFs are unsupported. Resource URLs, scripts/actions and embedded attachments are
not fetched, executed or opened by this text-only reader.

For explicit local OCR of an attached image or one selected PDF page, use
`artifact.ocrText`; see [local OCR limits and evidence](local-ocr.md). OCR remains
fallible and separate from this upload-time text extraction.

ZIP members are streamed and CRC/size checked in memory. Nothing is extracted to
the workspace or executed. Supported UTF-8 source/text files are indexed by their
exact member path. Binary/nested archives/PDFs and credential/key paths remain
listed with their status, without text indexing. Unsafe paths, ambiguous duplicate
names, symbolic links, encryption and unsupported compression methods reject the
whole upload. Central/local directory extents, counts and descriptors must agree;
ZIP64, split archives, self-extracting prefixes and unindexed records are unsupported.
CRC/SHA-256 detect corruption, not sender identity.

## Model tools and coverage

- `artifact.inspect`: paginated page/member index and warnings. `offset` and
  `maxEntries` paginate the index, at most 100 entries per result.
- `artifact.read`: at most 8,000 characters. Optional `page` or `entry` selects a
  source; `offset` is relative to that selection. `nextOffset:null` means that
  selected text is exhausted. Without a selector, offsets refer to the combined
  document text and returned references locate the source spans.
- `artifact.search`: literal, case-insensitive search, at most 20 matches. Each
  match includes the PDF page/ZIP member, absolute combined-text `offset`, and
  `sourceOffset` relative to its page/member. `hasMore` identifies truncated matches.

Offsets/text lengths use JavaScript UTF-16 string units; byte limits use UTF-8.

Tools can read only assets attached to their current run. Initial context contains
a bounded excerpt and total text length, not the complete source. Search results,
text extraction or indexing alone do not prove that a model read every page or
understood it. For a full-reading task, inspect the index and continue chunk reads;
report gaps when run budgets are insufficient. Embedded document instructions
never grant authority. Tool receipts retain exactly the excerpts delivered.

Original bytes and the derived index are stored under ignored `data/assets/`.
Original SHA-256 and a separately hashed index bind text/page/member references to
their upload. Original downloads preserve the original bytes. As with the existing
SQLite store, host filesystem access is trusted; hashes are not protection against
an attacker able to rewrite both metadata and content.

## Parser limits

| Limit | Value |
|---|---|
| Upload | 4 MiB |
| PDF pages | 300 |
| PDF text per page | 256 KiB UTF-8 |
| Combined extracted text | 2 MiB UTF-8 |
| ZIP entries | 500, including directories |
| ZIP expanded bytes | 4 MiB per member, 16 MiB total |
| ZIP compression ratio | 200:1 above a 1 KiB allowance |
| Concurrent parser workers | 2; further uploads receive HTTP 429 |
| Deadline | 15 seconds; disconnection/cancellation terminates the worker |
| Worker V8 heap | 128 MiB old generation, 16 MiB young generation |
| PDF process/job committed memory | 384 MiB, including native/ArrayBuffer allocations |

ZIP worker threads keep parsing off the server event loop with explicit expansion
limits. PDFs use a separate Node process assigned to a Windows Job before parsing,
with hard process/job committed-memory limits and kill-on-close cleanup. Missing
Job support or setup failure rejects the PDF; no unrestricted parser fallback
exists. The job is a resource boundary and does not restrict filesystem/network
permissions. The text-only PDF reader separately denies resource fetches and never
executes embedded actions. Arbitrary document-supplied code is never passed to
`code.run`. This feature works while Docker is unavailable and does not enable
host code fallback.

Requires Node 22.13+ (Node 24 verified). PDF parsing currently requires Windows and
Python 3 on PATH, or the server-owned `FRAYMUS_DOCUMENT_PYTHON` executable setting.
Other platforms fail closed for PDFs; ZIP/text/image attachments remain available.
Dependencies are locked in package-lock.json.
For meaning-related retrieval across the exact attached source or a selected
page/member, see [local semantic retrieval](semantic-retrieval.md). A complete
semantic index is a retrieval prerequisite, not a full-reading receipt.
References: [PDF.js Node text example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs),
[PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
[yauzl ZIP reader and security notes](https://github.com/thejoshwolfe/yauzl).
