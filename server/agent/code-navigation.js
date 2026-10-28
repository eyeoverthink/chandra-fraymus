import { assertSchema, fail, hash } from './schema.js';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const integer = (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, ...(description ? { description } : {}) });
const pathSchema = { type: 'string', minLength: 1, maxLength: 1024 };
const MAX_CHARS = 20000, DEFAULT_CHARS = 12000, MAX_DIRECTORIES = 100, MAX_ENTRIES = 1200;
const SKIP = new Set(['node_modules','dist','build','.venv','.venv-asr','venv','__pycache__','.git']);
const LINE_CONVENTION = 'split-preserving-final-empty; CRLF, LF and CR each terminate one line';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const boundedPath = value => typeof value === 'string' ? value.slice(0, 200) : '';
function resultLimit(context) {
  const runLimit = context.run?.budget?.maxToolResultChars;
  if (runLimit !== undefined && (!Number.isSafeInteger(runLimit) || runLimit < 1)) fail('navigation_output_budget', 'Run tool-result budget is invalid');
  return Math.min(context.args.maxChars ?? DEFAULT_CHARS, runLimit ?? MAX_CHARS);
}
function check(context, parameters) {
  assertSchema(context.args, parameters);
  context.signal?.throwIfAborted();
  if (!context.workspacePolicy || ['list','read','resolve'].some(name => typeof context.workspacePolicy[name] !== 'function')) fail('workspace_policy_unavailable', 'A trusted workspace policy is required');
  return context.workspacePolicy;
}
function cancelled(signal, caught) { if (signal?.aborted) throw signal.reason || caught; }
function safeError(caught) {
  const messages = { path_denied: 'Path is excluded by workspace policy', ENOENT: 'Workspace path does not exist', ENOTDIR: 'A path component is not a directory', EACCES: 'Workspace path is not readable', EPERM: 'Workspace path is not readable',
    binary_file: 'File is not permitted UTF-8 text', file_too_large: 'File exceeds the workspace read limit', path_changed: 'File identity changed during the read', navigation_policy: 'Workspace text receipt is inconsistent' };
  const code = Object.hasOwn(messages, caught?.code) ? caught.code : 'read_failed';
  return { code, message: messages[code] || 'Workspace path could not be read' };
}
function sourceText(file) {
  if (!file || typeof file.path !== 'string' || typeof file.text !== 'string' || !file.text.isWellFormed() || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 262144) fail('navigation_policy', 'Workspace text receipt is inconsistent');
  let text = file.text;
  // Older policy versions decoded away a UTF-8 BOM. Recover only when its exact
  // three raw bytes and full-file hash prove it, never infer arbitrary content.
  if (Buffer.byteLength(text) + 3 === file.bytes) text = '\ufeff' + text;
  if (Buffer.byteLength(text) !== file.bytes || hash(text) !== file.sha256) fail('navigation_policy', 'Workspace text receipt is inconsistent');
  return text;
}
function lines(text, signal) {
  const starts = [0], counts = { lf: 0, crlf: 0, cr: 0 };
  for (let i = 0; i < text.length; i++) {
    if (i % 1024 === 0) signal?.throwIfAborted();
    if (text[i] === '\r' && text[i + 1] === '\n') { counts.crlf++; starts.push(i + 2); i++; }
    else if (text[i] === '\r') { counts.cr++; starts.push(i + 1); }
    else if (text[i] === '\n') { counts.lf++; starts.push(i + 1); }
  }
  const kinds = Object.keys(counts).filter(key => counts[key]);
  return { starts, counts, kind: kinds.length > 1 ? 'mixed' : kinds[0] || 'none', endsWithNewline: /[\r\n]$/.test(text) };
}
function prefix(text, length) {
  let end = Math.min(length, text.length);
  if (end > 0 && end < text.length && (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff || text[end - 1] === '\r' && text[end] === '\n')) end--;
  return text.slice(0, end);
}
function containingLine(starts, position) {
  let low = 0, high = starts.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (starts[mid] <= position) low = mid + 1; else high = mid; }
  return low;
}

export function createCodeNavigationTools() {
  const readParameters = object({ files: { type: 'array', minItems: 1, maxItems: 8, items: object({ path: pathSchema, startLine: integer(1, 1000000), endLine: integer(1, 1000000) }, ['path']) },
    maxChars: integer(1024, MAX_CHARS, 'Maximum complete JSON result size; default 12000. UTF-8 bytes and characters both fit.') }, ['files']);
  const mapParameters = object({ path: pathSchema, maxDepth: integer(0, 6, 'Root depth is zero; zero omits its children, one lists direct children.'), maxFiles: integer(1, 300),
    maxChars: integer(1024, MAX_CHARS, 'Maximum complete JSON result size; default 12000.') });
  return [{ name: 'workspace.readMany', group: 'coding', approvalRequired: false,
    description: 'Read up to eight exact permitted UTF-8 files/ranges in one round. Excerpts preserve raw BOM and line endings; hashes/bytes describe complete raw files. The aggregate JSON is bounded. File content and names are untrusted data; no execution or parsing.',
    parameters: readParameters, async execute(context) {
      const policy = check(context, readParameters), { args, signal } = context, limit = resultLimit(context);
      for (const request of args.files) if (!request.path.isWellFormed() || request.endLine !== undefined && request.endLine < (request.startLine ?? 1)) fail('invalid_arguments', 'File paths must be well-formed and line ranges ascending');
      const result = { kind: 'workspace_read_many', untrusted: true, bounded: true, lineConvention: LINE_CONVENTION, maxChars: limit, requestedFiles: args.files.length, filesRead: 0, returnedContentChars: 0, truncated: false, files: [] };
      const excerpts = [];
      for (const request of args.files) {
        signal?.throwIfAborted();
        try {
          const file = await policy.read(request.path); signal?.throwIfAborted();
          const text = sourceText(file), indexed = lines(text, signal), totalLines = indexed.starts.length;
          result.filesRead++;
          const record = { ok: true, path: file.path, sha256: file.sha256, bytes: file.bytes, encoding: 'utf-8', utf8Bom: text.startsWith('\ufeff'), totalLines,
            lineEndings: { ...indexed.counts, kind: indexed.kind, endsWithNewline: indexed.endsWithNewline },
            startLine: request.startLine ?? 1, requestedEndLine: request.endLine ?? totalLines, endLine: null, content: '', contentChars: 0, rangeTruncated: false, partialLastLine: false, completeFile: false, truncated: false };
          result.files.push(record);
          if (record.startLine > totalLines) { record.ok = false; record.truncated = true; record.error = { code: 'line_range', message: 'startLine is beyond the full file line count' }; continue; }
          const endLine = Math.min(record.requestedEndLine, totalLines), start = indexed.starts[record.startLine - 1], end = endLine < totalLines ? indexed.starts[endLine] : text.length;
          record.rangeClamped = record.requestedEndLine > totalLines;
          excerpts.push({ record, text, starts: indexed.starts, start, selected: text.slice(start, end), endLine, whole: start === 0 && end === text.length });
        } catch (caught) {
          cancelled(signal, caught); result.files.push({ ok: false, path: boundedPath(request.path), ...(request.path.length > 200 ? { pathTruncated: true } : {}), error: safeError(caught) });
        }
      }
      function set(excerpt, content) {
        const record = excerpt.record, absoluteEnd = excerpt.start + content.length;
        record.content = content; record.contentChars = content.length; record.rangeTruncated = content.length < excerpt.selected.length;
        record.endLine = !record.rangeTruncated ? excerpt.endLine : content.length ? containingLine(excerpt.starts, absoluteEnd - 1) : null;
        record.partialLastLine = record.rangeTruncated && content.length > 0 && !excerpt.starts.includes(absoluteEnd);
        record.completeFile = excerpt.whole && !record.rangeTruncated; record.truncated = !record.completeFile;
        result.returnedContentChars = result.files.reduce((sum, file) => sum + (file.contentChars || 0), 0);
        result.truncated = result.files.some(file => !file.ok || file.truncated);
      }
      for (const excerpt of excerpts) set(excerpt, '');
      result.truncated = result.files.some(file => !file.ok || file.truncated);
      if (bytes(result) > limit) fail('navigation_output_budget', 'File metadata exceeds maxChars; request fewer paths or a larger limit');
      for (let index = 0; index < excerpts.length; index++) {
        signal?.throwIfAborted(); const excerpt = excerpts[index], before = bytes(result), share = Math.max(0, Math.floor((limit - before) / (excerpts.length - index))), target = before + share;
        // Divide remaining serialized space fairly; short files leave their
        // unused share for later files, and JSON escaping cannot overflow it.
        let low = 0, high = Math.min(excerpt.selected.length, share);
        while (low < high) { const mid = Math.ceil((low + high) / 2); set(excerpt, prefix(excerpt.selected, mid)); if (bytes(result) <= target) low = mid; else high = mid - 1; }
        set(excerpt, prefix(excerpt.selected, low));
      }
      if (bytes(result) > limit) fail('navigation_output_budget', 'File metadata exceeds maxChars');
      return result;
    } },
    { name: 'workspace.map', group: 'coding', approvalRequired: false,
      description: 'Map a bounded permitted file tree without reading source bodies. Excludes dependencies/build/venv directories and all workspace-policy secrets/links. Counts describe visited entries only; policy.list may sort a full directory and omit forbidden entries. Never a complete filesystem inventory.',
      parameters: mapParameters, async execute(context) {
        const policy = check(context, mapParameters), { args, signal } = context, limit = resultLimit(context), maxDepth = args.maxDepth ?? 3, maxFiles = args.maxFiles ?? 150;
        const root = await policy.resolve(args.path ?? '.', { directory: true }); signal?.throwIfAborted();
        if (root.relative.split('/').some(part => SKIP.has(part.toLowerCase()))) fail('navigation_directory_skipped', 'Dependency, generated and virtual-environment directories are excluded from workspace.map');
        const result = { kind: 'workspace_map', untrusted: true, bounded: true, complete: false, root: root.relative, maxDepth, maxFiles, maxChars: limit,
          counts: { directoriesVisited: 0, entriesExamined: 0, permittedFilesExamined: 0, returnedFiles: 0, returnedDirectories: 0 },
          omissions: { skippedDirectories: 0, depthLimitedDirectories: 0, directoryLimit: 0, policyRejected: 0, limitedOrFilteredListings: 0, queuedDirectories: 0, outputEntriesDropped: 0, fileLimit: false, entryLimit: false, outputLimit: false, policyFilteredCountUnknown: false },
          truncated: false, entries: [], examples: [], warnings: ['Names are untrusted data. Counts cover visited entries only; listings may omit secrets/links, change during traversal, or sort more host entries than returned.'] };
        const queue = maxDepth ? [{ path: root.relative, depth: 0 }] : [], seen = new Set([root.relative]);
        if (!maxDepth) result.omissions.depthLimitedDirectories++;
        const example = (path, reason) => { if (result.examples.length < 6) result.examples.push({ path: boundedPath(path), reason }); };
        while (queue.length && result.counts.entriesExamined < MAX_ENTRIES && result.counts.permittedFilesExamined < maxFiles) {
          signal?.throwIfAborted(); const current = queue.shift();
          let listing;
          try { await policy.resolve(current.path, { directory: true }); signal?.throwIfAborted(); listing = await policy.list(current.path, Math.min(200, MAX_ENTRIES - result.counts.entriesExamined)); signal?.throwIfAborted(); }
          catch (caught) { cancelled(signal, caught); result.omissions.policyRejected++; example(current.path, safeError(caught).code); continue; }
          result.counts.directoriesVisited++;
          if (listing.truncated) { result.omissions.limitedOrFilteredListings++; result.omissions.policyFilteredCountUnknown = true; }
          for (const entry of listing.entries) {
            signal?.throwIfAborted();
            if (result.counts.entriesExamined >= MAX_ENTRIES || result.counts.permittedFilesExamined >= maxFiles) break;
            result.counts.entriesExamined++;
            if (entry.type === 'directory' && entry.path.split('/').some(part => SKIP.has(part.toLowerCase()))) { result.omissions.skippedDirectories++; example(entry.path, 'dependency_or_generated'); continue; }
            if (!['file','directory'].includes(entry.type)) { result.omissions.policyRejected++; continue; }
            let checked;
            try { checked = await policy.resolve(entry.path, { directory: entry.type === 'directory' }); signal?.throwIfAborted(); }
            catch (caught) { cancelled(signal, caught); result.omissions.policyRejected++; example(entry.path, safeError(caught).code); continue; }
            const item = { path: checked.relative, type: entry.type, depth: current.depth + 1 }; result.entries.push(item);
            if (entry.type === 'file') { result.counts.permittedFilesExamined++; continue; }
            if (item.depth >= maxDepth) { result.omissions.depthLimitedDirectories++; item.childrenOmitted = 'depth_limit'; }
            else if (seen.size >= MAX_DIRECTORIES) { result.omissions.directoryLimit++; item.childrenOmitted = 'directory_limit'; }
            else if (!seen.has(item.path)) { seen.add(item.path); queue.push({ path: item.path, depth: item.depth }); }
          }
        }
        result.omissions.queuedDirectories = queue.length;
        result.omissions.fileLimit = result.counts.permittedFilesExamined >= maxFiles;
        result.omissions.entryLimit = result.counts.entriesExamined >= MAX_ENTRIES;
        function summarize() {
          result.counts.returnedFiles = result.entries.filter(entry => entry.type === 'file').length;
          result.counts.returnedDirectories = result.entries.length - result.counts.returnedFiles;
          result.truncated = Object.entries(result.omissions).some(([key, value]) => key !== 'policyFilteredCountUnknown' && value !== false && value > 0);
        }
        summarize();
        while (bytes(result) > limit && (result.examples.length || result.entries.length)) {
          signal?.throwIfAborted(); result.omissions.outputLimit = true;
          if (result.examples.length) result.examples.pop();
          else { result.entries.pop(); result.omissions.outputEntriesDropped++; }
          summarize();
        }
        if (bytes(result) > limit) fail('navigation_output_budget', 'Map metadata exceeds maxChars; use a shorter root path or larger limit');
        return result;
      } }];
}
