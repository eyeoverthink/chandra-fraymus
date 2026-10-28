import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateImage } from '../image-validation.js';

const ENGINE = 'windows-uia';
const LIMITS = Object.freeze({ windows: 32, nodes: 256, labelChars: 400, valueChars: 1000, inputChars: 4000,
  pngBytes: 4 * 1024 * 1024, pixels: 2073600, outputBytes: 8 * 1024 * 1024, inputBytes: 65536,
  timeoutMs: 12000, cleanupMs: 3000, snapshotMs: 180000, sessionMs: 900000 });
const DENIED = new Set(['cmd.exe','powershell.exe','pwsh.exe','windowsterminal.exe','wt.exe','conhost.exe','openconsole.exe',
  'consent.exe','credentialuibroker.exe','logonui.exe','winlogon.exe','taskmgr.exe','regedit.exe','mmc.exe','control.exe',
  'systemsettings.exe','rundll32.exe','wscript.exe','cscript.exe','mshta.exe','msiexec.exe','explorer.exe',
  'node.exe','python.exe','pythonw.exe','code.exe','codex.exe','chandra.exe','chrome.exe','msedge.exe','firefox.exe','brave.exe']);
const AMOUNTS = new Set(['none','smallIncrement','smallDecrement','largeIncrement','largeDecrement']);
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => Buffer.isBuffer(value) ? Buffer.from(value) : Array.isArray(value) ? value.map(copy)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key,item]) => [key,copy(item)])) : value;
const error = (code, message, details = {}) => {
  const safe = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
  const beforeDispatch = safe.outcome !== 'outcome_unknown' && ['desktop_stale','desktop_plan_expired','desktop_denied','desktop_not_visible','desktop_element_unavailable','desktop_unsupported','desktop_arguments','desktop_session_expired','desktop_window_expired','desktop_session_exists','desktop_busy','desktop_unavailable'].includes(code);
  return Object.assign(new Error(message), { code, ...(beforeDispatch ? { dispatched: false, outcome: 'not_dispatched' } : {}), ...safe });
};
const fail = (code, message, details) => { throw error(code, message, details); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const identity = value => path.win32.normalize(value).toLowerCase();
const printable = value => typeof value === 'string' && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const safeTitle = value => printable(value) && value.length <= 400 && !/\b(?:chandra|myaipartner|codex|windows security|user account control)\b/i.test(value);
const rectangle = value => exact(value, ['x','y','width','height']) && ['x','y','width','height'].every(key => Number.isInteger(value[key])) && Math.abs(value.x) <= 131072 && Math.abs(value.y) <= 131072 && value.width > 0 && value.height > 0 && value.width <= 32768 && value.height <= 32768;
const supportedPatterns = value => Array.isArray(value) && value.length <= 16 && value.every(name => typeof name === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(name));
const SET_VALUE_DENIALS = new Set(['legacy_protected','legacy_read_only','legacy_unavailable','legacy_offscreen_or_invisible','legacy_busy','not_edit_or_document','legacy_role_not_supported','restricted_control','not_enabled','read_only','legacy_pattern_unavailable','full_value_unavailable','context_policy_blocked','text_read_only','writable_text_attribute_unavailable']);
const NATIVE_PHASES = new Set(['initialize','request_validation','window_validation','observation','element_validation','set_value_preflight','set_value_revalidation','set_value_dispatch','native_text_preflight','native_text_revalidation','native_text_dispatch','invoke_preflight','invoke_dispatch','scroll_preflight','scroll_dispatch','after_observation','completed']);
const textAction = operation => operation === 'setValue' || operation === 'setNativeText';
const patternKey = operation => operation === 'setValue' ? 'value' : operation === 'setNativeText' ? 'nativeText' : operation;
const basicEditClass = name => typeof name === 'string' && name.length <= 200 && (/^Edit$/i.test(name) || /^WindowsForms10\.EDIT\.app\.[0-9a-f]{1,16}\.[0-9a-f]{1,16}_r[0-9]{1,3}_ad[0-9]{1,3}$/i.test(name));
function nativeEditFacts(item, window) {
  const proof = item.nativeEdit;
  if (proof === undefined && item.patterns.nativeText !== true) return undefined;
  if (!exact(proof, ['hwnd','rootHwnd','pid','creationTime','className','style','unicode','valueSha256','valueChars'])
    || typeof proof.hwnd !== 'string' || !/^[1-9][0-9]{0,19}$/.test(proof.hwnd) || proof.hwnd === window.hwnd || proof.hwnd !== item.nativeWindowHandle
    || proof.rootHwnd !== window.hwnd || proof.pid !== window.pid || proof.creationTime !== window.creationTime
    || !basicEditClass(proof.className) || !Number.isInteger(proof.style) || proof.style < 0 || proof.style > 0xffffffff
    || ((proof.style >>> 0) & 0x50000000) !== 0x50000000 || ((proof.style >>> 0) & 0x08000820) !== 0 || proof.unicode !== true
    || !['ControlType.Edit','ControlType.Document'].includes(item.role) || item.enabled !== true || item.readOnly !== false || item.legacyReadOnly === true || item.valueReadOnly === true || item.textReadOnly === true
    || item.legacyState !== undefined && (!Number.isInteger(item.legacyState) || (item.legacyState & 0x20018841) !== 0)
    || typeof proof.valueSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.valueSha256) || proof.valueSha256 !== item.valueSha256
    || !Number.isInteger(proof.valueChars) || proof.valueChars < 0 || proof.valueChars > 32767 || proof.valueChars !== item.valueChars) fail('desktop_protocol', 'Native Edit scope/style/value proof is invalid');
  return { className: proof.className, method: 'WM_SETTEXT', timeoutMs: 2000, maxTextBytes: 65536 };
}
function nativeDiagnostics(value) {
  const result = {};
  const invalid = () => fail('desktop_protocol', 'Native desktop diagnostics are invalid');
  if (value.nativePhase !== undefined) {
    if (!NATIVE_PHASES.has(value.nativePhase) || typeof value.dispatchAttempted !== 'boolean') invalid();
    result.nativePhase = value.nativePhase;
  }
  if (value.dispatchAttempted !== undefined) {
    if (typeof value.dispatchAttempted !== 'boolean') invalid();
    result.dispatchAttempted = value.dispatchAttempted;
  }
  for (const key of ['plannedTextTransport','textTransport']) if (value[key] !== undefined) {
    if (!['value','legacy','win32_edit'].includes(value[key])) invalid();
    result[key] = value[key];
  }
  if (value.nativeHresult !== undefined || value.nativeHresultSource !== undefined) {
    if (!Number.isInteger(value.nativeHresult) || value.nativeHresult < -2147483648 || value.nativeHresult > 2147483647
      || !['legacy_set_value','managed_exception'].includes(value.nativeHresultSource)) invalid();
    if (value.nativeHresultSource === 'legacy_set_value' && value.textTransport !== 'legacy') invalid();
    result.nativeHresult = value.nativeHresult; result.nativeHresultSource = value.nativeHresultSource;
  }
  if (value.nativeWin32Error !== undefined) {
    if (!Number.isInteger(value.nativeWin32Error) || value.nativeWin32Error < 0 || value.nativeWin32Error > 0xffffffff) invalid();
    result.nativeWin32Error = value.nativeWin32Error;
  }
  if (value.dispatchAttempted === false && (value.textTransport !== undefined || value.dispatched === true || ['set_value_dispatch','native_text_dispatch','invoke_dispatch','scroll_dispatch','after_observation','completed'].includes(value.nativePhase))) invalid();
  if (value.dispatchAttempted === true && value.nativePhase !== undefined && !['set_value_dispatch','native_text_dispatch','invoke_dispatch','scroll_dispatch','after_observation','completed'].includes(value.nativePhase)) invalid();
  if (value.plannedTextTransport !== undefined && value.textTransport !== undefined && value.plannedTextTransport !== value.textTransport) invalid();
  return result;
}
const unsupportedMessage = (element, operation = 'setValue') => `${textAction(operation) && element.readOnly === true ? 'Selected element is read-only; no text mutation is available.' : 'Selected element does not expose a supported pattern for this operation.'} Observed UIA patterns: ${supportedPatterns(element.supportedPatterns) && element.supportedPatterns.length ? element.supportedPatterns.join(', ') : 'none reported'}.${operation === 'setValue' && SET_VALUE_DENIALS.has(element.setValueDenial) ? ` Text setter denial: ${element.setValueDenial}.` : ''}`;
function textFacts(element) {
  const result = {};
  for (const key of ['legacyRole','legacyState']) if (element[key] !== undefined) {
    if (!Number.isInteger(element[key]) || element[key] < 0 || element[key] > 0xffffffff) fail('desktop_protocol', 'Native legacy diagnostic number is invalid');
    result[key] = element[key];
  }
  for (const key of ['legacyReadOnly','valueReadOnly','textReadOnly','textReadOnlyKnown']) if (element[key] !== undefined) {
    if (typeof element[key] !== 'boolean') fail('desktop_protocol', 'Native read-only diagnostic is invalid');
    result[key] = element[key];
  }
  if (element.setValueDenial !== undefined && element.setValueDenial !== null) {
    if (!SET_VALUE_DENIALS.has(element.setValueDenial)) fail('desktop_protocol', 'Native setter diagnostic is invalid');
    result.setValueDenial = element.setValueDenial;
  }
  return result;
}
const deepFreeze = value => { if (value && typeof value === 'object' && !Buffer.isBuffer(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

function nativeTransport({ pythonPath, timeoutMs }) {
  const helper = fileURLToPath(new URL('./windows-job.py', import.meta.url));
  return (request, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(error('desktop_cancelled', 'Desktop operation was cancelled before dispatch', { dispatched: false, outcome: 'not_dispatched', cleanup: { confirmed: true, processStarted: false } })); return; }
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) + 1 > LIMITS.inputBytes) { reject(error('desktop_protocol', 'Native desktop request exceeds its protocol limit')); return; }
    const env = {};
    for (const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH','Path']) if (process.env[key]) env[key] = process.env[key];
    let child, timer, grace, force, finished = false, cancellation, bytes = 0, overflow = false;
    const parts = [];
    const finish = (failure, value) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(grace); clearTimeout(force); signal?.removeEventListener('abort', abort);
      child?.stdin.destroy();
      if (failure) reject(failure); else resolve(value);
    };
    const cancel = reason => {
      if (cancellation || finished) return;
      cancellation = reason;
      try { child.stdin.write('CANCEL\n'); } catch {}
      grace = setTimeout(() => {
        child.kill();
        force = setTimeout(() => finish(error('desktop_cleanup_uncertain', 'Desktop controller cleanup could not be confirmed', { cleanup: { confirmed: false }, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })), 1000);
      }, LIMITS.cleanupMs);
    };
    const abort = () => cancel('desktop_cancelled');
    try {
      child = spawn(pythonPath, ['-I', helper], { env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      child.stdin.on('error', () => {});
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LIMITS.outputBytes) { overflow = true; cancel('desktop_output_limit'); }
        else parts.push(chunk);
      });
      child.stdout.on('error', () => cancel('desktop_native_failed'));
      child.once('error', () => finish(error('desktop_unavailable', 'The bounded Windows desktop helper could not start', { cleanup: { confirmed: true, processStarted: false } })));
      child.once('close', code => {
        if (finished) return;
        let envelope;
        try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
        catch { finish(error('desktop_cleanup_uncertain', 'Desktop helper did not return a bounded cleanup receipt', { cleanup: { confirmed: false }, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })); return; }
        if (envelope?.cleanup?.confirmed !== true || envelope.cleanup.remainingProcesses !== 0) {
          finish(error('desktop_cleanup_uncertain', 'Desktop helper cleanup was not confirmed', { cleanup: { confirmed: false }, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })); return;
        }
        if (code !== 0 && envelope.ok === true) { finish(error('desktop_native_failed', 'Desktop helper exited abnormally after returning data', { cleanup: envelope.cleanup, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })); return; }
        if (cancellation || overflow) {
          finish(error(cancellation || 'desktop_output_limit', cancellation === 'desktop_timeout' ? 'Desktop operation exceeded its deadline' : 'Desktop operation was cancelled or exceeded its output limit',
            { cleanup: envelope.cleanup, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })); return;
        }
        finish(null, envelope);
      });
      child.stdin.write(payload + '\n'); // Keep pipe open: its next frame/EOF is the helper's cancellation signal.
      timer = setTimeout(() => cancel('desktop_timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch {
      if (child?.pid) { child.kill(); finish(error('desktop_cleanup_uncertain', 'Desktop controller transport failed after process creation', { cleanup: { confirmed: false }, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined })); }
      else finish(error('desktop_unavailable', 'The bounded Windows desktop helper could not start', { cleanup: { confirmed: true, processStarted: false } }));
    }
  });
}

/** Trusted server configuration only. The broker owns run grants and human approval. */
export function createWindowsDesktopDriver({ enabled = false, allowedExecutables = [], pythonPath = process.env.FRAYMUS_DESKTOP_PYTHON || 'python',
  nativeTransport: transport, timeoutMs = LIMITS.timeoutMs, platform = process.platform, now = Date.now } = {}) {
  const sessions = new Map(), windows = new Map(), plans = new Map();
  let busy = false, quarantine = false, checkedAt = null, ready = false, configReason;
  let allowed = [];
  try {
    if (typeof enabled !== 'boolean' || !Array.isArray(allowedExecutables) || allowedExecutables.length > 16 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000) throw new Error();
    allowed = allowedExecutables.map(value => {
      if (typeof value !== 'string' || value.length > 1024 || !path.win32.isAbsolute(value) || value.startsWith('\\\\') || path.win32.extname(value).toLowerCase() !== '.exe' || DENIED.has(path.win32.basename(value).toLowerCase()) || /[\x00-\x1f]/.test(value)) throw new Error();
      return path.win32.normalize(value);
    });
    if (new Set(allowed.map(identity)).size !== allowed.length) throw new Error();
  } catch { configReason = 'invalid_allowlist_or_driver_configuration'; }
  const callTransport = transport || nativeTransport({ pythonPath, timeoutMs });
  const availableConfiguration = () => enabled && platform === 'win32' && allowed.length > 0 && !configReason && !quarantine;
  function requireEnabled() {
    if (!availableConfiguration()) fail('desktop_unavailable', quarantine ? 'Desktop driver is quarantined after an uncertain operation; close/restart it before reuse' : 'Attended Windows desktop control requires operator enablement and an exact executable allowlist');
  }
  async function call(request, signal) {
    requireEnabled();
    if (signal?.aborted) fail('desktop_cancelled', 'Desktop operation was cancelled before dispatch', { dispatched: false, outcome: 'not_dispatched' });
    if (busy) fail('desktop_busy', 'Another attended desktop operation is in progress');
    busy = true;
    try {
      const envelope = await callTransport({ ...request, allowlist: [...allowed] }, { signal, timeoutMs, maxOutputBytes: LIMITS.outputBytes });
      if (envelope?.cleanup?.confirmed !== true || envelope.cleanup.remainingProcesses !== 0) fail('desktop_cleanup_uncertain', 'Desktop cleanup receipt is missing', { cleanup: { confirmed: false } });
      let diagnostics;
      try { diagnostics = nativeDiagnostics(envelope.data || {}); }
      catch { fail('desktop_protocol', 'Native desktop diagnostics are invalid', { cleanup: envelope.cleanup, ...(request.operation === 'act' ? { outcome: 'outcome_unknown' } : {}) }); }
      if (envelope.ok !== true || envelope.data?.ok !== true) {
        const code = envelope.data?.error?.code || envelope.error?.code;
        const allowedCodes = new Set(['desktop_stale','desktop_denied','desktop_not_visible','desktop_capture_unavailable','desktop_element_unavailable','desktop_unsupported','desktop_cancelled','desktop_timeout','desktop_output_limit']);
        const selected = allowedCodes.has(code) ? code : 'desktop_native_failed';
        const outcome = request.operation === 'act' && envelope.data?.dispatchAttempted === true ? 'outcome_unknown'
          : request.operation === 'act' && envelope.data?.dispatchAttempted === false ? 'not_dispatched' : undefined;
        const detail = envelope.data?.error;
        const observed = supportedPatterns(detail?.supportedPatterns) ? detail.supportedPatterns : undefined;
        fail(selected, selected === 'desktop_unsupported' ? unsupportedMessage({ supportedPatterns: observed, readOnly: detail?.readOnly }, request.action?.operation) : 'The selected desktop operation was denied or could not complete',
          { cleanup: envelope.cleanup, outcome, ...(outcome === 'not_dispatched' ? { dispatched: false } : {}), ...(observed ? { supportedPatterns: observed } : {}), ...(typeof detail?.readOnly === 'boolean' ? { readOnly: detail.readOnly } : {}), ...diagnostics });
      }
      return { ...envelope.data, ...diagnostics, cleanup: envelope.cleanup };
    } catch (caught) {
      if (caught?.cleanup?.confirmed === false || request.operation === 'act' && caught?.outcome !== 'not_dispatched' && !['desktop_stale','desktop_denied','desktop_not_visible','desktop_element_unavailable','desktop_unsupported'].includes(caught?.code)) quarantine = true;
      if (caught?.code?.startsWith('desktop_')) throw caught;
      quarantine = true;
      throw error('desktop_native_failed', 'Desktop controller failed without a trusted result', { cleanup: { confirmed: false }, outcome: request.operation === 'act' ? 'outcome_unknown' : undefined });
    } finally { busy = false; }
  }
  function target(value) {
    if (!value || typeof value.hwnd !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.hwnd) || !Number.isInteger(value.pid) || value.pid < 1
      || typeof value.creationTime !== 'string' || !/^[0-9]{1,20}$/.test(value.creationTime) || typeof value.executable !== 'string' || !allowed.some(item => identity(item) === identity(value.executable)) || !safeTitle(value.title)) fail('desktop_protocol', 'Native window identity is invalid');
    return { hwnd: value.hwnd, pid: value.pid, creationTime: value.creationTime, executable: value.executable, title: value.title };
  }
  function session(id) {
    requireEnabled();
    const found = sessions.get(id);
    if (!found || found.closed || found.expiresAt <= now()) fail('desktop_session_expired', 'Desktop session is missing, closed or expired');
    return found;
  }
  function ownedCall(owner, request, signal) {
    const combined = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    const pending = call(request, combined); owner.pending = pending;
    return pending.finally(() => { if (owner.pending === pending) owner.pending = null; });
  }
  function image(value) {
    if (!value || value.method !== 'PrintWindow' || value.mimeType !== 'image/png' || typeof value.dataBase64 !== 'string' || value.dataBase64.length > Math.ceil(LIMITS.pngBytes / 3) * 4) fail('desktop_capture_unavailable', 'Selected-window PNG receipt is invalid');
    const bytes = Buffer.from(value.dataBase64, 'base64');
    if (!bytes.length || bytes.length > LIMITS.pngBytes || bytes.toString('base64') !== value.dataBase64 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('desktop_capture_unavailable', 'Selected-window PNG bytes are invalid');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > LIMITS.pixels || width !== value.width || height !== value.height || value.sha256 !== sha(bytes)) fail('desktop_capture_unavailable', 'Selected-window image size/hash did not match');
    try { validateImage(bytes, 'image/png'); } catch { fail('desktop_capture_unavailable', 'Selected-window PNG structure or compressed pixels were invalid'); }
    if (!Number.isInteger(value.passwordRegionsMasked) || value.passwordRegionsMasked < 0 || value.passwordRegionsMasked > 64) fail('desktop_capture_unavailable', 'Selected-window privacy mask receipt is invalid');
    return { mimeType: 'image/png', bytes, width, height, sha256: value.sha256, method: 'PrintWindow', passwordRegionsMasked: value.passwordRegionsMasked };
  }
  function observation(owner, native, includeImage) {
    const bound = target(native.window);
    if (['hwnd','pid','creationTime','executable'].some(key => key === 'executable' ? identity(bound[key]) !== identity(owner.target[key]) : bound[key] !== owner.target[key])) fail('desktop_stale', 'Selected window/process identity changed');
    if (typeof native.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(native.fingerprint) || !rectangle(native.bounds) || !Array.isArray(native.elements) || native.elements.length > LIMITS.nodes) fail('desktop_protocol', 'Native UIA observation exceeded its schema limits');
    const ids = native.elements.map(() => randomUUID()), privateElements = new Map();
    const elements = native.elements.map((item, index) => {
      if (!item || !Array.isArray(item.runtimeId) || !item.runtimeId.length || item.runtimeId.length > 64 || item.runtimeId.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
        || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) || item.password === true || item.hidden === true || !printable(item.name) || item.name.length > LIMITS.labelChars
        || !printable(item.role) || item.role.length > 100 || !printable(item.automationId) || item.automationId.length > LIMITS.labelChars || !exact(item.patterns, ['invoke','value','nativeText','scroll'])
        || ['invoke','value','scroll'].some(key => typeof item.patterns[key] !== 'boolean') || item.patterns.nativeText !== undefined && typeof item.patterns.nativeText !== 'boolean' || typeof item.enabled !== 'boolean' || item.parentIndex !== null && (!Number.isInteger(item.parentIndex) || item.parentIndex < 0 || item.parentIndex >= index)
        || !rectangle(item.bounds) || item.value !== undefined && (!printable(item.value) || item.value.length > LIMITS.valueChars)
        || item.supportedPatterns !== undefined && !supportedPatterns(item.supportedPatterns) || item.readOnly !== undefined && typeof item.readOnly !== 'boolean'
        || item.textAccess !== undefined && item.textAccess !== null && !['value','legacy','text','win32_edit'].includes(item.textAccess)) fail('desktop_protocol', 'Native UIA element schema is invalid');
      const nativeText = nativeEditFacts(item, bound);
      const elementId = ids[index]; privateElements.set(elementId, copy(item));
      return { elementId, parentId: item.parentIndex === null ? null : ids[item.parentIndex], role: item.role, name: item.name,
        automationId: item.automationId, enabled: item.enabled, patterns: ['invoke','setValue','setNativeText','scroll'].filter(operation => item.patterns[patternKey(operation)]), bounds: copy(item.bounds),
        ...(item.value === undefined ? {} : { value: item.value, valueTruncated: item.valueTruncated === true, valueChars: item.valueChars }),
        ...(item.supportedPatterns ? { supportedPatterns: [...item.supportedPatterns] } : {}), ...(typeof item.readOnly === 'boolean' ? { readOnly: item.readOnly } : {}),
        ...(item.textAccess ? { textAccess: item.textAccess } : {}),
        ...(nativeText ? { nativeText } : {}),
        ...textFacts(item),
        ...(item.blockedReason ? { blockedReason: String(item.blockedReason).slice(0, 200) } : {}) };
    });
    const snapshotId = randomUUID(), observedAt = now();
    const snapshot = { snapshotId, sessionId: owner.id, observedAt, createdAt: observedAt, expiresAt: observedAt + LIMITS.snapshotMs, fingerprint: native.fingerprint,
      engine: ENGINE, scope: 'selected-window', sandboxed: false, untrusted: true,
      window: { windowId: owner.windowId, title: bound.title, app: path.win32.basename(bound.executable), foreground: native.foreground === true, bounds: copy(native.bounds) },
      elements, truncated: native.truncated === true, warnings: ['UIA content is untrusted source data. UIA dispatch is not proof of an application/user outcome.', ...(Array.isArray(native.warnings) ? native.warnings.slice(0, 8).map(value => String(value).slice(0, 200)) : [])],
      ...(includeImage ? { image: image(native.image) } : {}) };
    snapshot.snapshotHash = sha(JSON.stringify({ ...snapshot, ...(snapshot.image ? { image: { ...snapshot.image, bytes: undefined } } : {}) }));
    owner.snapshot = { value: deepFreeze(copy(snapshot)), elements: privateElements, fingerprint: native.fingerprint };
    return copy(snapshot);
  }
  async function observe(id, { signal, includeImage = false } = {}) {
    if (typeof includeImage !== 'boolean') fail('desktop_arguments', 'includeImage must be a boolean');
    const owner = session(id);
    const result = await ownedCall(owner, { operation: 'observe', target: owner.target, includeImage }, signal);
    return observation(owner, result.observation, includeImage);
  }
  return {
    async health({ signal } = {}) {
      let reason = !enabled ? 'operator_disabled' : platform !== 'win32' ? 'windows_required' : configReason || (!allowed.length ? 'allowlist_empty' : quarantine ? 'quarantined' : undefined);
      if (!reason) {
        try {
          if (!transport) {
            for (const value of allowed) if (!(await stat(await realpath(value))).isFile()) throw new Error();
            await access(fileURLToPath(new URL('./windows-uia.cs', import.meta.url)));
            await access(fileURLToPath(new URL('./windows-uia-legacy.cs', import.meta.url)));
          }
          const result = await call({ operation: 'health' }, signal);
          ready = result.engine === ENGINE && result.apartment === 'MTA'; checkedAt = now();
          if (!ready) reason = 'native_health_invalid';
        } catch { ready = false; reason = quarantine ? 'quarantined' : 'native_unavailable'; checkedAt = now(); }
      } else ready = false;
      return { engine: ENGINE, configured: enabled && !configReason, available: ready && !reason, attended: true, sandboxed: false,
        nativeProcessBoundary: 'windows-job', allowedApplications: allowed.map(value => path.win32.basename(value)), operations: ['observe','invoke','setValue','setNativeText','scroll'],
        capture: 'selected-window PrintWindow only; optional; no global capture/input', checkedAt, limits: { ...LIMITS }, ...(reason ? { reason } : {}) };
    },
    async listWindows({ signal } = {}) {
      const result = await call({ operation: 'list' }, signal);
      if (!Array.isArray(result.windows) || result.windows.length > LIMITS.windows) fail('desktop_protocol', 'Native window inventory is invalid');
      windows.clear();
      const listed = result.windows.map(value => {
        const selected = target(value), windowId = randomUUID(); windows.set(windowId, { target: selected, expiresAt: now() + LIMITS.snapshotMs });
        return { windowId, title: selected.title, app: path.win32.basename(selected.executable), foreground: value.foreground === true };
      });
      return { engine: ENGINE, windows: listed, untrusted: true };
    },
    async openSession({ windowId } = {}, { signal } = {}) {
      requireEnabled();
      const selected = windows.get(windowId);
      if (!selected || selected.expiresAt <= now()) fail('desktop_window_expired', 'Select a current allowlisted window ID from the inventory');
      if (sessions.size) fail('desktop_session_exists', 'Close the existing attended desktop session before selecting another window');
      const id = randomUUID(), owner = { id, windowId, target: selected.target, expiresAt: now() + LIMITS.sessionMs, controller: new AbortController() };
      sessions.set(id, owner);
      try { const initial = await observe(id, { signal, includeImage: false }); return { sessionId: id, window: copy(initial.window), expiresAt: owner.expiresAt, observation: initial }; }
      catch (caught) { sessions.delete(id); throw caught; }
    },
    observe,
    prepare(id, action) {
      const owner = session(id), snapshot = owner.snapshot;
      if (!exact(action, ['snapshotId','elementId','operation','value','horizontal','vertical']) || !snapshot || snapshot.value.snapshotId !== action.snapshotId || snapshot.value.expiresAt <= now()) fail('desktop_stale', 'Action requires a current observation from this exact session');
      const element = snapshot.elements.get(action.elementId);
      if (!element || !element.enabled || element.blockedReason) fail('desktop_denied', 'Target is unavailable, disabled or denied by desktop policy');
      if (!['invoke','setValue','setNativeText','scroll'].includes(action.operation)) fail('desktop_arguments', 'Only invoke, setValue, setNativeText and scroll are supported');
      if (!element.patterns[patternKey(action.operation)]) fail('desktop_unsupported', unsupportedMessage(element, action.operation),
        { ...(supportedPatterns(element.supportedPatterns) ? { supportedPatterns: [...element.supportedPatterns] } : {}), ...(typeof element.readOnly === 'boolean' ? { readOnly: element.readOnly } : {}), ...textFacts(element) });
      if (textAction(action.operation)) {
        if (!printable(action.value) || action.value.length > LIMITS.inputChars || action.horizontal !== undefined || action.vertical !== undefined) fail('desktop_arguments', 'Text setting requires at most 4000 literal characters and no scroll arguments');
      } else if (action.operation === 'scroll') {
        if (action.value !== undefined || !AMOUNTS.has(action.horizontal ?? 'none') || !AMOUNTS.has(action.vertical ?? 'none') || (action.horizontal ?? 'none') === 'none' && (action.vertical ?? 'none') === 'none') fail('desktop_arguments', 'scroll requires at least one bounded semantic scroll amount');
      } else if (action.value !== undefined || action.horizontal !== undefined || action.vertical !== undefined) fail('desktop_arguments', 'invoke does not accept values or scroll arguments');
      const planId = randomUUID(), expiresAt = Math.min(snapshot.value.expiresAt, owner.expiresAt);
      const plan = { planId, sessionId: id, snapshotId: action.snapshotId, elementId: action.elementId, operation: action.operation, expiresAt,
        preview: { planId, sessionId: id, snapshotId: action.snapshotId, snapshotHash: snapshot.value.snapshotHash, expiresAt,
          engine: ENGINE, sandboxed: false, window: copy(snapshot.value.window), beforeSnapshotId: action.snapshotId,
          beforeSnapshotHash: snapshot.value.snapshotHash, observedAt: snapshot.value.observedAt, target: { name: element.name, role: element.role, automationId: element.automationId,
            ...(element.value === undefined ? {} : { value: element.value, valueTruncated: element.valueTruncated === true, valueChars: element.valueChars }),
            ...(element.textAccess ? { textAccess: element.textAccess } : {}), ...(typeof element.readOnly === 'boolean' ? { readOnly: element.readOnly } : {}),
            ...(action.operation === 'setNativeText' ? { nativeText: nativeEditFacts(element, owner.target) } : {}),
            ...(supportedPatterns(element.supportedPatterns) ? { supportedPatterns: [...element.supportedPatterns] } : {}) },
          operation: action.operation, ...(action.value === undefined ? {} : { value: action.value }),
          ...(action.operation === 'scroll' ? { horizontal: action.horizontal ?? 'none', vertical: action.vertical ?? 'none' } : {}),
          effect: action.operation === 'setNativeText' ? 'Explicit native Edit WM_SETTEXT may trigger application side effects; exact readback is required. No focus change, keys, clipboard or fallback.' : 'Semantic input may trigger application side effects; dispatch does not prove completion. No focus change, hotkeys or global input.' } };
      plans.set(planId, { ...copy(plan), action: copy(action), target: copy(owner.target), element: copy(element), fingerprint: snapshot.fingerprint, includeImage: !!snapshot.value.image });
      return deepFreeze(copy(plan));
    },
    async execute(planId, { signal } = {}) {
      const plan = plans.get(planId);
      if (!plan) fail('desktop_plan_expired', 'Desktop action plan is missing or already consumed');
      plans.delete(planId); // Single use, including cancelled/stale attempts; no action retry.
      const owner = session(plan.sessionId);
      if (plan.expiresAt <= now() || owner.snapshot?.value.snapshotId !== plan.snapshotId) fail('desktop_stale', 'Desktop action plan expired or its observation changed');
      let native;
      try {
        native = await ownedCall(owner, { operation: 'act', target: plan.target, expectedFingerprint: plan.fingerprint, expiresAt: plan.expiresAt,
          element: { runtimeId: plan.element.runtimeId, fingerprint: plan.element.fingerprint }, action: plan.action, includeImage: plan.includeImage }, signal);
      } catch (caught) {
        if (caught.outcome === 'outcome_unknown') quarantine = true;
        if (quarantine) { owner.closed = true; sessions.delete(owner.id); }
        throw caught;
      }
      if (native.dispatched !== true || !['input_dispatched','value_verified','outcome_unknown'].includes(native.effectState)) { quarantine = true; fail('desktop_protocol', 'Desktop dispatch receipt is invalid', { outcome: 'outcome_unknown', cleanup: native.cleanup, ...nativeDiagnostics(native) }); }
      if (native.effectState === 'value_verified' && (!textAction(plan.operation) || !native.after?.elements?.some(item => JSON.stringify(item.runtimeId) === JSON.stringify(plan.element.runtimeId)
        && (plan.operation === 'setNativeText' ? item.nativeEdit?.valueSha256 : item.valueSha256) === sha(plan.action.value)))) {
        quarantine = true; sessions.delete(owner.id); fail('desktop_protocol', 'Native value verification did not match the exact dispatched text', { outcome: 'outcome_unknown', cleanup: native.cleanup, ...nativeDiagnostics(native) });
      }
      let after, afterError;
      try { if (native.after) after = observation(owner, native.after, plan.includeImage); else throw new Error(); }
      catch { afterError = 'Fresh selected-window observation was unavailable after dispatch'; }
      const effectState = afterError || textAction(plan.operation) && native.effectState !== 'value_verified' ? 'outcome_unknown' : native.effectState;
      if (effectState === 'outcome_unknown') { quarantine = true; sessions.delete(owner.id); }
      return { engine: ENGINE, planId, sessionId: plan.sessionId, operation: plan.operation, beforeSnapshotId: plan.snapshotId,
        beforeSnapshotHash: plan.preview.beforeSnapshotHash, target: copy(plan.preview.target), window: copy(plan.preview.window), status: effectState, dispatched: true, effectObserved: effectState === 'outcome_unknown' ? null : effectState === 'value_verified', sandboxed: false,
        dispatch: plan.operation === 'setNativeText' ? 'Bounded native Edit message returned; exact readback is required and application/user outcome is not implied' : 'UIA control pattern returned; application/user outcome is not implied', cleanup: native.cleanup,
        ...nativeDiagnostics(native),
        ...(after ? { afterSnapshotId: after.snapshotId, after } : { afterError }) };
    },
    async close(id) {
      const found = sessions.get(id);
      if (found) { found.closed = true; found.controller.abort(); sessions.delete(id); }
      for (const [key, plan] of plans) if (plan.sessionId === id) plans.delete(key);
      let cleanup = { confirmed: true, remainingProcesses: 0, processStarted: false };
      if (found?.pending) {
        let timer;
        try {
          const result = await Promise.race([found.pending.then(value => value.cleanup, caught => caught.cleanup || { confirmed: false }),
            new Promise(resolve => { timer = setTimeout(() => resolve({ confirmed: false }), LIMITS.cleanupMs + 1500); })]);
          cleanup = result;
        } finally { clearTimeout(timer); }
      }
      if (cleanup?.confirmed !== true) { quarantine = true; cleanup = { confirmed: false, reason: 'Session controller cleanup was not confirmed' }; }
      return { sessionId: id, closed: true, applicationClosed: false, cleanup };
    },
  };
}
