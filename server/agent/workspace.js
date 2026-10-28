import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fail, hash } from './schema.js';

const MAX_FILE_BYTES = 256 * 1024;
const writeQueues = new Map();
const writeLeases = new WeakMap();
export function textLineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  return {lf:(text.match(/\n/g) || []).length-crlf,crlf,cr:(text.match(/\r/g) || []).length-crlf};
}
const denied = /^(?:\.git(?:config|modules)?|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const keyFile = /\.(?:pem|key|p12|pfx|kdbx|keystore)$/i;
const credentialFile = /^(?:\.git-credentials|api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|client[_-]?secrets?|service[_-]?account(?:[_-]?keys?)?|authorized_keys|known_hosts)(?:[._-].*)?$/i;
const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export function allowedRelative(input, allowRoot = false) {
  if (allowRoot && (input === '.' || input === '')) return [];
  if (typeof input !== 'string' || !input || !input.isWellFormed() || input.length > 1024 || path.isAbsolute(input) || /^[a-z]:/i.test(input)) fail('path_denied', 'A workspace-relative path is required');
  const parts = input.split(/[\\/]/);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || denied.test(part) || keyFile.test(part) || credentialFile.test(part) || device.test(part)) fail('path_denied', 'Path contains a forbidden component');
  }
  return parts;
}
export function createWorkspacePolicy(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) fail('invalid_workspace', 'Workspace must be an absolute directory');
  let rootPromise;
  const root = () => rootPromise ??= fs.realpath(workspace).then(async real => {
    if (!(await fs.stat(real)).isDirectory()) fail('invalid_workspace', 'Workspace is not a directory');
    return real;
  });
  const inside = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  async function resolve(input = '.', { allowMissing = false, directory = false } = {}) {
    const parts = allowedRelative(input, directory);
    const base = await root();
    let current = base;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (error.code === 'ENOENT' && allowMissing && i === parts.length - 1) {
          const parentReal = await fs.realpath(path.dirname(current));
          if (!inside(base, parentReal)) fail('path_denied', 'Path resolves outside workspace');
          return { path: current, relative: parts.join('/'), exists: false, parentReal };
        }
        throw error;
      }
      if (stat.isSymbolicLink()) fail('path_denied', 'Symlinks and junctions are not allowed');
      if (i < parts.length - 1 && !stat.isDirectory()) fail('path_denied', 'Path parent is not a directory');
      const real = await fs.realpath(current);
      if (!inside(base, real)) fail('path_denied', 'Path resolves outside workspace');
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('path_denied', directory ? 'A directory is required' : 'A regular file is required');
    if (!directory && stat.nlink > 1) fail('path_denied', 'Hard-linked files are not allowed');
    return { path: current, relative: parts.join('/') || '.', exists: true, stat, parentReal: await fs.realpath(path.dirname(current)) };
  }
  async function read(input) {
    const target = await resolve(input);
    if (target.stat.size > MAX_FILE_BYTES) fail('file_too_large', `File exceeds ${MAX_FILE_BYTES} bytes`);
    const handle = await fs.open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const checked = await resolve(input);
      if (opened.dev !== checked.stat.dev || opened.ino !== checked.stat.ino || opened.size > MAX_FILE_BYTES) fail('path_changed', 'File changed while opening');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!next.bytesRead) break;
        bytesRead += next.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES) fail('file_too_large', 'File grew beyond the size limit');
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) fail('binary_file', 'Use a modality adapter for binary files');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); } catch { fail('binary_file', 'File is not valid UTF-8 text'); }
      return { path: target.relative, text, sha256: hash(content), bytes: bytesRead, utf8Bom:content.length>=3&&content[0]===239&&content[1]===187&&content[2]===191,lineEndings:textLineEndings(text) };
    } finally { await handle.close(); }
  }
  async function identity(input) {
    const target=await resolve(input),handle=await fs.open(target.path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try {
      const opened=await handle.stat({bigint:true}),checked=await resolve(input),current=await fs.stat(checked.path,{bigint:true});
      if(opened.dev!==current.dev||opened.ino!==current.ino||opened.nlink>1n)fail('path_changed','File identity changed while opening');
      const base=await root();
      return hash('workspace-file-identity-v1\n'+(process.platform==='win32'?base.toLowerCase():base)+'\n'+opened.dev+'\n'+opened.ino);
    }finally{await handle.close();}
  }
  async function canonicalWriteKey(input,{allowMissing=false}={}) {
    const target=await resolve(input,{allowMissing}),canonical=target.exists?await fs.realpath(target.path):path.join(target.parentReal,path.basename(target.path));
    return process.platform==='win32'?canonical.toLowerCase():canonical;
  }
  function queueWrite(key) {
    const preceding=writeQueues.get(key)||Promise.resolve();let release;
    const held=new Promise(resolve=>{release=resolve;}),tail=preceding.catch(()=>{}).then(()=>held);writeQueues.set(key,tail);
    return {wait:preceding.catch(()=>{}),release:()=>{release();if(writeQueues.get(key)===tail)writeQueues.delete(key);}};
  }
  async function withWriteLocks(paths,{signal}={},callback) {
    if(!Array.isArray(paths)||!paths.length||paths.length>8||typeof callback!=='function')fail('invalid_write_lease','One to eight existing paths and an owned callback are required');
    signal?.throwIfAborted();
    const targets=[];
    for(const input of paths)targets.push({input,key:await canonicalWriteKey(input),identity:await identity(input)});
    if(new Set(targets.map(target=>target.key)).size!==targets.length||new Set(targets.map(target=>target.identity)).size!==targets.length)fail('path_alias','Write targets must refer to distinct files');
    const held=[];let lease,record;
    try {
      for(const target of [...targets].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)) {
        signal?.throwIfAborted();const lock=queueWrite(target.key);held.push(lock);await lock.wait;signal?.throwIfAborted();
      }
      for(const target of targets)if(await canonicalWriteKey(target.input)!==target.key||await identity(target.input)!==target.identity)fail('path_changed','A target identity changed while waiting for its cooperative write lease');
      signal?.throwIfAborted();lease=Object.freeze({});
      record={active:true,accepting:true,targets:new Map(targets.map(target=>[target.key,target.identity])),operations:new Set(),root:await root()};writeLeases.set(lease,record);
      return await callback(lease);
    }finally{
      if(record){record.accepting=false;await Promise.allSettled([...record.operations]);record.active=false;writeLeases.delete(lease);}
      for(const lock of held.reverse())lock.release();
    }
  }
  async function previewWrite(args) {
    if (typeof args.content!=='string'||!args.content.isWellFormed()||args.content.includes('\0')) fail('invalid_text','Workspace content must be well-formed UTF-8 text without NUL');
    if ((args.createOnly === true) === Boolean(args.expectedHash)) fail('write_precondition', 'Supply exactly one of createOnly:true or expectedHash');
    if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) fail('file_too_large', 'Write exceeds file size limit');
    const target = await resolve(args.path, { allowMissing: true });
    let previousHash = null;
    if (args.createOnly && target.exists) fail('write_conflict', 'createOnly target already exists');
    if (args.expectedHash) {
      if (!target.exists) fail('write_conflict', 'Expected existing file is missing');
      previousHash = (await read(args.path)).sha256;
      if (previousHash !== args.expectedHash) fail('write_conflict', 'File hash does not match expectedHash');
    }
    return { path: target.relative, createOnly: args.createOnly === true, previousHash, newHash: hash(args.content), bytes: Buffer.byteLength(args.content), content: args.content.slice(0, 12000), previewTruncated: args.content.length > 12000 };
  }
  async function write(args, {signal,beforeDispatch,lease} = {}) {
    if(lease!==undefined){
      const record=lease&&typeof lease==='object'?writeLeases.get(lease):null;
      if(!record?.active||!record.accepting)fail('invalid_write_lease','An original active write lease is required');
      const operation=(async()=>{
        signal?.throwIfAborted();const key=await canonicalWriteKey(args.path);
        if(record.root!==await root()||record.targets.get(key)!==await identity(args.path))fail('invalid_write_lease','Write target is not covered by this lease');
        if(!record.active)fail('invalid_write_lease','The write lease expired before dispatch');
        return writeOwned(args,{signal,beforeDispatch:()=>{if(!record.active)fail('invalid_write_lease','The write lease expired before dispatch');beforeDispatch?.();}});
      })();
      record.operations.add(operation);operation.then(()=>record.operations.delete(operation),()=>record.operations.delete(operation));
      return operation;
    }
    signal?.throwIfAborted();
    const key=await canonicalWriteKey(args.path,{allowMissing:true}),lock=queueWrite(key);await lock.wait;
    try { signal?.throwIfAborted();return await writeOwned(args,{signal,beforeDispatch}); }
    finally {lock.release();}
  }
  async function writeOwned(args,{signal,beforeDispatch}) {
    const preview = await previewWrite(args);
    const target = await resolve(args.path, { allowMissing: true });
    const flags = constants.O_WRONLY | (constants.O_NOFOLLOW || 0) | (args.createOnly ? constants.O_CREAT | constants.O_EXCL : 0);
    const handle = await fs.open(target.path, flags, 0o600);
    try {
      const opened = await handle.stat();
      const checked = await resolve(args.path);
      if (opened.dev !== checked.stat.dev || opened.ino !== checked.stat.ino || !inside(await root(), await fs.realpath(target.path))) fail('path_changed', 'Write target changed');
      if (args.expectedHash && (await read(args.path)).sha256 !== args.expectedHash) fail('write_conflict', 'File changed since approval');
      signal?.throwIfAborted();
      beforeDispatch?.();
      await handle.writeFile(args.content, 'utf8');
      await handle.truncate(Buffer.byteLength(args.content));
      await handle.sync();
      return { path: preview.path, sha256: preview.newHash, bytes: preview.bytes };
    } finally { await handle.close(); }
  }
  async function list(input = '.', maxEntries = 100) {
    const target = await resolve(input, { directory: true });
    const entries = await fs.readdir(target.path, { withFileTypes: true });
    const results = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = target.relative === '.' ? entry.name : `${target.relative}/${entry.name}`;
      try { allowedRelative(relative); } catch { continue; }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      results.push({ path: relative, type: entry.isDirectory() ? 'directory' : 'file' });
      if (results.length >= maxEntries) break;
    }
    return { entries: results, truncated: entries.length > results.length };
  }
  async function search({ query, path: input = '.', maxResults = 30 }, signal) {
    const queue = [input]; const matches = []; let filesScanned = 0, entriesScanned = 0, bytesScanned = 0;
    while (queue.length && filesScanned < 100 && entriesScanned < 2000 && bytesScanned < 2 * 1024 * 1024 && matches.length < maxResults) {
      signal?.throwIfAborted();
      const dir = queue.shift();
      const listing = await list(dir, 200);
      for (const entry of listing.entries) {
        signal?.throwIfAborted();
        entriesScanned++;
        if (entry.type === 'directory') { if (queue.length < 100 && !/(?:^|\/)(?:node_modules|dist|build|\.venv)$/.test(entry.path)) queue.push(entry.path); continue; }
        if (filesScanned >= 100 || entriesScanned >= 2000 || bytesScanned >= 2 * 1024 * 1024) break;
        let file;
        try { file = await read(entry.path); } catch { continue; }
        filesScanned++; bytesScanned += file.bytes;
        for (const [index, line] of file.text.split(/\r\n|\n|\r/).entries()) {
          if (line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= maxResults) break;
        }
        if (matches.length >= maxResults) break;
      }
    }
    return { matches, filesScanned, bytesScanned, bounded: true };
  }
  return { root, resolve, identity,withWriteLocks,read,write,previewWrite,list,search };
}
