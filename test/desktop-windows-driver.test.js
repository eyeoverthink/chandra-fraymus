import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWindowsDesktopDriver } from '../server/desktop/windows-driver.js';
import { encodeRgbaPng } from '../server/transport/rgba.js';

const executable = 'C:\\approved\\FraymusDesktopFixture.exe';
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const bounds = { x: 0, y: 0, width: 600, height: 400 };
const target = { hwnd: '123456', pid: 987, creationTime: '133700000000000000', executable, title: 'Fraymus Desktop Fixture' };
const cleanup = { confirmed: true, remainingProcesses: 0, backend: 'windows-job', jobTerminated: true, controllerExited: true };
const pngFixture = encodeRgbaPng(Buffer.from([1, 2, 3, 4]), { width: 2, compression: 'none' });
const png = pngFixture.png;
function harness(options = {}) {
  let clock = 1000, value = '', generation = 1;
  const calls = [];
  function raw(includeImage = false) {
    const elements = [
      { runtimeId: [42, 1], fingerprint: digest('root'), parentIndex: null, role: 'ControlType.Window', name: target.title, automationId: '', enabled: true, patterns: { invoke: false, value: false, scroll: false }, bounds },
      { runtimeId: [42, 2], fingerprint: digest('edit:' + value), parentIndex: 0, role: 'ControlType.Edit', name: 'Draft', automationId: 'DraftInput', value, valueChars: value.length,
        valueTruncated: false, valueSha256: digest(value), enabled: true, patterns: { invoke: false, value: true, scroll: false }, bounds },
      { runtimeId: [42, generation + 2], fingerprint: digest('button:' + generation), parentIndex: 0, role: 'ControlType.Button', name: 'Apply', automationId: 'ApplyDraft', enabled: true, patterns: { invoke: true, value: false, scroll: false }, bounds },
      { runtimeId: [42, 99], fingerprint: digest('scroll'), parentIndex: 0, role: 'ControlType.Pane', name: 'Results', automationId: 'Results', enabled: true, patterns: { invoke: false, value: false, scroll: true }, bounds },
    ];
    return { window: json(target), bounds, foreground: false, fingerprint: digest(value + generation), elements, truncated: false,
      ...(includeImage ? { image: { method: 'PrintWindow', mimeType: 'image/png', dataBase64: png.toString('base64'), width: pngFixture.width, height: pngFixture.height, sha256: digest(png), passwordRegionsMasked: 1 } } : {}) };
  }
  const transport = async (request, context) => {
    calls.push(json(request));
    if (options.transport) return options.transport(request, raw, context);
    let data;
    if (request.operation === 'health') data = { ok: true, engine: 'windows-uia', apartment: 'MTA' };
    if (request.operation === 'list') data = { ok: true, windows: [{ ...target, foreground: false }] };
    if (request.operation === 'observe') data = { ok: true, observation: raw(request.includeImage) };
    if (request.operation === 'act') {
      if (request.expectedFingerprint !== raw().fingerprint || !raw().elements.some(item => JSON.stringify(item.runtimeId) === JSON.stringify(request.element.runtimeId) && item.fingerprint === request.element.fingerprint)) data = { ok: false, error: { code: 'desktop_stale' } };
      else {
        if (request.action.operation === 'setValue') value = request.action.value;
        data = { ok: true, dispatched: true, effectState: request.action.operation === 'setValue' ? 'value_verified' : 'input_dispatched', after: raw(request.includeImage) };
      }
    }
    return { ok: true, data, cleanup };
  };
  const driver = createWindowsDesktopDriver({ enabled: true, platform: 'win32', allowedExecutables: [executable], nativeTransport: transport, now: () => clock, ...options.driver });
  return { driver, calls, raw, tick: amount => { clock += amount; }, change: () => { generation++; }, edit: text => { value = text; } };
}
async function selected(h) {
  const listed = await h.driver.listWindows();
  return h.driver.openSession({ windowId: listed.windows[0].windowId });
}
function action(observation, operation = 'invoke') {
  return { snapshotId: observation.snapshotId, elementId: observation.elements.find(item => item.patterns.includes(operation)).elementId, operation };
}
function nativeEditView(raw, value = '') {
  const view = raw();
  Object.assign(view.elements[1], { role: 'ControlType.Document', value, valueChars: value.length, valueTruncated: false, valueSha256: digest(value), readOnly: false,
    legacyRole: 15, legacyState: 0x100000, legacyReadOnly: false, textReadOnlyKnown: true, textReadOnly: false,
    nativeWindowHandle: '456789', supportedPatterns: ['TextPattern','LegacyIAccessiblePattern'], patterns: { invoke: false, value: false, nativeText: true, scroll: false },
    nativeEdit: { hwnd: '456789', rootHwnd: target.hwnd, pid: target.pid, creationTime: target.creationTime, className: 'WindowsForms10.EDIT.app.0.141b42a_r8_ad1',
      style: 0x500100c4, unicode: true, valueSha256: digest(value), valueChars: value.length } });
  return view;
}

test('desktop control defaults disabled; exact executable policy rejects shell/browser/security/approval hosts', async () => {
  let calls = 0;
  const disabled = createWindowsDesktopDriver({ nativeTransport: async () => { calls++; } });
  assert.equal((await disabled.health()).available, false);
  await assert.rejects(disabled.listWindows(), { code: 'desktop_unavailable' }); assert.equal(calls, 0);
  for (const path of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\powershell.exe', 'C:\\app\\Codex.exe', 'C:\\app\\chrome.exe', '\\\\server\\app.exe', 'relative.exe']) {
    const h = harness({ driver: { allowedExecutables: [path] } });
    assert.equal((await h.driver.health()).available, false); assert.equal(h.calls.length, 0);
  }
});

test('inventory and selected session expose opaque IDs only and text observation does not capture images', async () => {
  const h = harness();
  const health = await h.driver.health(); assert.equal(health.available, true); assert.equal(health.sandboxed, false);
  const listed = await h.driver.listWindows();
  assert.equal(listed.windows[0].app, 'FraymusDesktopFixture.exe');
  assert.equal(Object.hasOwn(listed.windows[0], 'hwnd'), false); assert.equal(Object.hasOwn(listed.windows[0], 'pid'), false); assert.equal(Object.hasOwn(listed.windows[0], 'creationTime'), false);
  await assert.rejects(h.driver.openSession({ windowId: '123456' }), { code: 'desktop_window_expired' });
  const opened = await h.driver.openSession({ windowId: listed.windows[0].windowId });
  assert.ok(opened.sessionId); assert.equal(opened.window.app, 'FraymusDesktopFixture.exe'); assert.equal(opened.observation.image, undefined);
  assert.equal(h.calls.at(-1).includeImage, false);
  assert.equal(opened.observation.elements[1].patterns[0], 'setValue');
  assert.equal(opened.observation.elements[1].runtimeId, undefined);
  assert.equal(opened.observation.elements[1].fingerprint, undefined);
  assert.equal(opened.observation.createdAt, 1000);
  assert.equal(opened.observation.window.foreground, false);
});

test('prepare binds immutable exact IDs/preview/context; background semantic setValue verifies exact value and observes after', async () => {
  const h = harness(), opened = await selected(h), before = opened.observation;
  const args = { ...action(before, 'setValue'), value: 'Literal draft $(); " text\nsecond line' };
  const plan = h.driver.prepare(opened.sessionId, args);
  assert.equal(plan.preview.planId, plan.planId); assert.equal(plan.preview.sessionId, opened.sessionId);
  assert.equal(plan.preview.snapshotHash, before.snapshotHash); assert.equal(plan.preview.value, args.value);
  assert.ok(Object.isFrozen(plan.preview.target)); assert.throws(() => { plan.preview.value = 'changed'; }, TypeError);
  args.value = 'caller mutation';
  const receipt = await h.driver.execute(plan.planId);
  assert.equal(receipt.status, 'value_verified'); assert.equal(receipt.effectObserved, true);
  assert.equal(receipt.after.elements[1].value, 'Literal draft $(); " text\nsecond line');
  assert.equal(receipt.cleanup.confirmed, true); assert.equal(receipt.beforeSnapshotId, before.snapshotId);
  assert.notEqual(receipt.afterSnapshotId, before.snapshotId);
  assert.equal(h.calls.at(-1).target.hwnd, target.hwnd); assert.equal(h.calls.at(-1).expectedFingerprint, before.fingerprint);
  await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_plan_expired' });
});

test('Invoke and Scroll report dispatch only; arbitrary scripts, global input and unsupported patterns are not accepted', async () => {
  const h = harness(), opened = await selected(h);
  for (const args of [{ ...action(opened.observation), script: 'evil()' }, { ...action(opened.observation), operation: 'sendKeys' }, { ...action(opened.observation), value: 'extra' }]) assert.throws(() => h.driver.prepare(opened.sessionId, args));
  let plan = h.driver.prepare(opened.sessionId, action(opened.observation));
  let result = await h.driver.execute(plan.planId);
  assert.equal(result.status, 'input_dispatched'); assert.equal(result.effectObserved, false);
  const current = result.after;
  assert.throws(() => h.driver.prepare(opened.sessionId, action(current, 'scroll')), { code: 'desktop_arguments' });
  plan = h.driver.prepare(opened.sessionId, { ...action(current, 'scroll'), vertical: 'smallIncrement' });
  result = await h.driver.execute(plan.planId); assert.equal(result.status, 'input_dispatched');
  assert.throws(() => h.driver.prepare(opened.sessionId, { ...action(result.after), operation: 'setValue', value: 'text' }), { code: 'desktop_unsupported' });
});

test('editable Document legacy transport uses the same exact full-field verification beyond the observation excerpt', async () => {
  for (const forgedPrefixOnly of [false, true]) {
    let fullValue = '';
    const legacyView = raw => {
      const view = raw(), field = view.elements[1];
      Object.assign(field, { role: 'ControlType.Document', textAccess: 'legacy', setValueTransport: 'legacy', readOnly: false,
        legacyRole: 15, legacyState: 0x100000, legacyReadOnly: false, textReadOnlyKnown: true, textReadOnly: false,
        supportedPatterns: ['LegacyIAccessiblePattern','TextPattern','ScrollPattern'], value: fullValue.slice(0, 1000), valueChars: fullValue.length,
        valueTruncated: fullValue.length > 1000, valueSha256: digest(forgedPrefixOnly ? fullValue.slice(0, 1000) : fullValue) });
      return view;
    };
    const h = harness({ transport: async (request, raw) => {
      if (request.operation === 'list') return { ok: true, cleanup, data: { ok: true, windows: [target] } };
      if (request.operation === 'act') {
        fullValue = request.action.value;
        return { ok: true, cleanup, data: { ok: true, dispatched: true, effectState: 'value_verified', textTransport: 'legacy', after: legacyView(raw) } };
      }
      return { ok: true, cleanup, data: { ok: true, observation: legacyView(raw) } };
    } });
    const opened = await selected(h), field = opened.observation.elements[1];
    assert.equal(field.role, 'ControlType.Document'); assert.equal(field.textAccess, 'legacy'); assert.equal(field.readOnly, false);
    assert.deepEqual(field.supportedPatterns, ['LegacyIAccessiblePattern','TextPattern','ScrollPattern']);
    const plan = h.driver.prepare(opened.sessionId, { snapshotId: opened.observation.snapshotId, elementId: field.elementId, operation: 'setValue', value: 'first line\n' + 'x'.repeat(2490) });
    if (forgedPrefixOnly) await assert.rejects(h.driver.execute(plan.planId), caught => caught.code === 'desktop_protocol' && caught.outcome === 'outcome_unknown');
    else {
      const result = await h.driver.execute(plan.planId);
      assert.equal(result.status, 'value_verified'); assert.equal(result.textTransport, 'legacy');
      assert.equal(result.after.elements[1].value.length, 1000); assert.equal(result.after.elements[1].valueTruncated, true);
      assert.equal(result.after.elements[1].valueChars, fullValue.length);
    }
  }
});

test('explicit native Edit operation has its own observed pattern, approval preview and full-value proof with no automatic UIA fallback', async () => {
  let current = '';
  const h = harness({ transport: async (request, raw) => {
    if (request.operation === 'act') {
      assert.equal(request.action.operation, 'setNativeText'); assert.equal(request.action.hwnd, undefined); assert.equal(request.action.message, undefined);
      current = request.action.value;
      const after = nativeEditView(raw, current); after.elements[1].value = current.slice(0, 1000); after.elements[1].valueTruncated = current.length > 1000;
      return { ok: true, cleanup, data: { ok: true, dispatched: true, dispatchAttempted: true, nativePhase: 'completed', plannedTextTransport: 'win32_edit', textTransport: 'win32_edit', effectState: 'value_verified', after } };
    }
    return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: nativeEditView(raw, current) } };
  } });
  const opened = await selected(h), field = opened.observation.elements[1];
  assert.deepEqual(field.patterns, ['setNativeText']); assert.equal(field.nativeText.method, 'WM_SETTEXT'); assert.equal(field.nativeText.timeoutMs, 2000);
  assert.equal(field.nativeEdit, undefined); assert.equal(field.nativeWindowHandle, undefined); assert.ok(!JSON.stringify(opened).includes('456789'));
  assert.throws(() => h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), operation: 'setValue', value: 'no fallback' }), { code: 'desktop_unsupported' });
  for (const extra of [{ hwnd: '456789' }, { message: 0xc }, { timeoutMs: 9999 }, { horizontal: 'none' }, { value: '\ud800' }])
    assert.throws(() => h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), value: 'literal', ...extra }));
  const plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), value: 'first line\n' + 'λ'.repeat(1990) });
  assert.equal(plan.preview.operation, 'setNativeText'); assert.equal(plan.preview.target.nativeText.method, 'WM_SETTEXT');
  assert.ok(!JSON.stringify(plan).includes('456789')); assert.equal(h.calls.filter(item => item.operation === 'act').length, 0);
  const result = await h.driver.execute(plan.planId);
  assert.equal(result.operation, 'setNativeText'); assert.equal(result.status, 'value_verified'); assert.equal(result.effectObserved, true); assert.equal(result.textTransport, 'win32_edit');
  assert.equal(result.after.elements[1].valueTruncated, true); assert.equal(result.after.elements[1].valueChars, current.length);
  assert.equal(h.calls.filter(item => item.operation === 'act').length, 1);
});

test('native Edit scope proofs reject mismatched owners/roots and readonly/password/non-Edit classes before any action', async () => {
  const cases = [
    view => view.elements[1].nativeEdit.pid++, view => { view.elements[1].nativeEdit.rootHwnd = '999'; },
    view => { view.elements[1].nativeEdit.hwnd = target.hwnd; }, view => { view.elements[1].nativeWindowHandle = '999'; },
    view => { delete view.elements[1].nativeEdit; }, view => { view.elements[1].nativeEdit.creationTime = '133800000000000000'; },
    view => { view.elements[1].nativeEdit.className = 'RichEdit50W'; }, view => { view.elements[1].nativeEdit.className = 'Chrome_RenderWidgetHostHWND'; },
    ...[0x20,0x800,0x08000000].map(flag => view => { view.elements[1].nativeEdit.style |= flag; }),
    ...[0x10000000,0x40000000].map(flag => view => { view.elements[1].nativeEdit.style &= ~flag; }),
    view => { view.elements[1].nativeEdit.unicode = false; }, view => { view.elements[1].readOnly = true; },
    view => { view.elements[1].textReadOnly = true; }, view => { view.elements[1].legacyReadOnly = true; },
    view => { view.elements[1].legacyState |= 0x20000000; }, view => { view.elements[1].nativeEdit.valueSha256 = digest('different complete field'); },
    view => { view.elements[1].nativeEdit.valueChars = 32768; },
  ];
  for (const change of cases) {
    const h = harness({ transport: async (request, raw) => {
      const view = nativeEditView(raw); change(view);
      return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: view } };
    } });
    await assert.rejects(selected(h), { code: 'desktop_protocol' }); assert.equal(h.calls.filter(item => item.operation === 'act').length, 0);
  }
});

test('native Edit timeout diagnostics are retained and unknown actions quarantine without retry or fallback', async () => {
  for (const win32Error of [0, 1460, 0xffffffff]) {
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
      : request.operation === 'act' ? { ok: false, error: { code: 'desktop_native_failed' }, dispatchAttempted: true, nativePhase: 'native_text_dispatch', plannedTextTransport: 'win32_edit', textTransport: 'win32_edit', nativeWin32Error: win32Error }
      : { ok: true, observation: nativeEditView(raw) } }) });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), value: 'approved literal' });
    await assert.rejects(h.driver.execute(plan.planId), caught => caught.code === 'desktop_native_failed' && caught.outcome === 'outcome_unknown' && caught.dispatchAttempted === true
      && caught.nativePhase === 'native_text_dispatch' && caught.nativeWin32Error === win32Error && caught.textTransport === 'win32_edit' && caught.cleanup.confirmed === true);
    assert.equal((await h.driver.health()).reason, 'quarantined'); await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_plan_expired' });
    assert.equal(h.calls.filter(item => item.operation === 'act').length, 1);
  }
  const stale = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
    : request.operation === 'act' ? { ok: false, error: { code: 'desktop_stale' }, dispatchAttempted: false, nativePhase: 'native_text_revalidation', plannedTextTransport: 'win32_edit' }
    : request.operation === 'health' ? { ok: true, engine: 'windows-uia', apartment: 'MTA' } : { ok: true, observation: nativeEditView(raw) } }) });
  const opened = await selected(stale), plan = stale.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), value: 'denied before dispatch' });
  await assert.rejects(stale.driver.execute(plan.planId), caught => caught.code === 'desktop_stale' && caught.outcome === 'not_dispatched' && caught.dispatchAttempted === false
    && caught.nativePhase === 'native_text_revalidation' && caught.textTransport === undefined);
  assert.equal((await stale.driver.health()).available, true);
});

test('native Edit mismatched readback or forged prefix hash can never prove a text effect', async () => {
  for (const forged of [false, true]) {
    const approved = 'x'.repeat(1500), actual = forged ? approved : 'the actual complete field differs';
    const h = harness({ transport: async (request, raw) => {
      const after = nativeEditView(raw, actual); after.elements[1].value = actual.slice(0, 1000); after.elements[1].valueTruncated = actual.length > 1000;
      if (forged) after.elements[1].nativeEdit.valueSha256 = digest(actual.slice(0, 1000));
      return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
        : request.operation === 'act' ? { ok: true, dispatched: true, dispatchAttempted: true, nativePhase: 'completed', plannedTextTransport: 'win32_edit', textTransport: 'win32_edit', effectState: forged ? 'value_verified' : 'input_dispatched', after }
        : { ok: true, observation: nativeEditView(raw) } };
    } });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setNativeText'), value: approved });
    if (forged) await assert.rejects(h.driver.execute(plan.planId), caught => caught.code === 'desktop_protocol' && caught.outcome === 'outcome_unknown' && caught.textTransport === 'win32_edit');
    else { const result = await h.driver.execute(plan.planId); assert.equal(result.status, 'outcome_unknown'); assert.equal(result.effectObserved, null); }
    assert.equal((await h.driver.health()).reason, 'quarantined');
  }
});

test('read-only and native unsupported diagnostics list bounded observed patterns without suggesting read-only mutation', async () => {
  const patterns = ['ValuePattern','TextPattern','LegacyIAccessiblePattern'];
  const h = harness({ transport: async (request, raw) => {
    const view = raw(); Object.assign(view.elements[1], { readOnly: true, supportedPatterns: patterns, textAccess: 'value', patterns: { invoke: false, value: false, scroll: false } });
    return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: view } };
  } });
  const opened = await selected(h);
  assert.throws(() => h.driver.prepare(opened.sessionId, { snapshotId: opened.observation.snapshotId, elementId: opened.observation.elements[1].elementId, operation: 'setValue', value: 'must not write' }), caught =>
    caught.code === 'desktop_unsupported' && caught.dispatched === false && caught.outcome === 'not_dispatched' && caught.message.includes('read-only') && caught.message.includes('LegacyIAccessiblePattern') && !caught.message.includes('try'));
  assert.equal(h.calls.filter(item => item.operation === 'act').length, 0);
  const native = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
    : request.operation === 'act' ? { ok: false, dispatchAttempted: false, error: { code: 'desktop_unsupported', supportedPatterns: patterns, readOnly: true } }
    : request.operation === 'health' ? { ok: true, engine: 'windows-uia', apartment: 'MTA' } : { ok: true, observation: raw() } }) });
  const selectedNative = await selected(native), plan = native.driver.prepare(selectedNative.sessionId, action(selectedNative.observation));
  await assert.rejects(native.driver.execute(plan.planId), caught => caught.code === 'desktop_unsupported' && caught.outcome === 'not_dispatched' && caught.message.includes('ValuePattern') && caught.readOnly === true);
  assert.equal((await native.driver.health()).available, true);
});

test('legacy role/state and explicit setter denial remain guarded diagnostic facts, not extra authority', async () => {
  const diagnosticView = raw => {
    const view = raw(); Object.assign(view.elements[1], { role: 'ControlType.Document', textAccess: 'legacy', readOnly: false,
      legacyRole: 15, legacyState: 0x100004, legacyReadOnly: false, setValueDenial: 'legacy_role_not_supported',
      supportedPatterns: ['ScrollPattern','TextPattern','LegacyIAccessiblePattern'], patterns: { invoke: false, value: false, scroll: true } });
    return view;
  };
  const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: diagnosticView(raw) } }) });
  const opened = await selected(h), field = opened.observation.elements[1];
  assert.equal(field.legacyRole, 15); assert.equal(field.legacyState, 0x100004); assert.equal(field.legacyReadOnly, false);
  assert.equal(field.setValueDenial, 'legacy_role_not_supported'); assert.deepEqual(field.patterns, ['scroll']);
  assert.throws(() => h.driver.prepare(opened.sessionId, { snapshotId: opened.observation.snapshotId, elementId: field.elementId, operation: 'setValue', value: 'never dispatched' }), caught =>
    caught.code === 'desktop_unsupported' && caught.legacyRole === 15 && caught.legacyState === 0x100004 && caught.message.includes('legacy_role_not_supported') && caught.dispatched === false);
  assert.equal(h.calls.filter(request => request.operation === 'act').length, 0);
  for (const change of [{ legacyRole: -1 }, { legacyState: 0x100000000 }, { legacyState: '0x40' }, { legacyReadOnly: 'false' }, { textReadOnlyKnown: 'true' }, { textReadOnly: 'false' }, { setValueDenial: 'arbitrary source text' }]) {
    const broken = harness({ transport: async (request, raw) => {
      const view = diagnosticView(raw); Object.assign(view.elements[1], change);
      return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: view } };
    } });
    await assert.rejects(selected(broken), { code: 'desktop_protocol' });
  }
});

test('stale element/context, updated observation, expiry and cross-session identifiers never dispatch an action', async () => {
  const h = harness(), opened = await selected(h);
  let plan = h.driver.prepare(opened.sessionId, action(opened.observation));
  h.change(); await assert.rejects(h.driver.execute(plan.planId), error => error.code === 'desktop_stale' && error.dispatched === false && error.outcome === 'not_dispatched');
  const fresh = await h.driver.observe(opened.sessionId);
  assert.throws(() => h.driver.prepare(opened.sessionId, action(opened.observation)), { code: 'desktop_stale' });
  plan = h.driver.prepare(opened.sessionId, action(fresh));
  await h.driver.observe(opened.sessionId);
  const beforeCalls = h.calls.length; await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_stale' }); assert.equal(h.calls.length, beforeCalls);
  const last = await h.driver.observe(opened.sessionId); plan = h.driver.prepare(opened.sessionId, action(last));
  h.tick(180001); await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_stale' });
  assert.throws(() => h.driver.prepare('arbitrary-session', action(last)), { code: 'desktop_session_expired' });
});

test('window identity, hidden/password elements and malformed native snapshots fail closed', async () => {
  for (const mutate of [view => { view.window.pid++; }, view => { view.window.executable = 'C:\\other\\app.exe'; }, view => { view.elements[1].password = true; }, view => { view.elements[1].hidden = true; }, view => { view.elements[1].runtimeId = [1.2]; }, view => { view.elements[1].parentIndex = 3; }]) {
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: (() => { const view = raw(); mutate(view); return view; })() } }) });
    const listed = await h.driver.listWindows(); await assert.rejects(h.driver.openSession({ windowId: listed.windows[0].windowId }));
  }
});

test('explicit selected-window images return private Buffers with verified dimensions/hash and no base64 exposure', async () => {
  const h = harness(), opened = await selected(h);
  const view = await h.driver.observe(opened.sessionId, { includeImage: true });
  assert.ok(Buffer.isBuffer(view.image.bytes)); assert.equal(view.image.mimeType, 'image/png'); assert.equal(view.image.dataBase64, undefined);
  assert.equal(view.image.method, 'PrintWindow'); assert.equal(view.image.passwordRegionsMasked, 1);
  assert.equal(view.image.width, pngFixture.width); assert.equal(view.image.height, pngFixture.height); assert.equal(view.image.sha256, digest(png));
  view.image.bytes[0] = 0;
  const again = await h.driver.observe(opened.sessionId, { includeImage: true }); assert.equal(again.image.bytes[0], 137);
  const bad = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: (() => { const view = raw(request.includeImage); if (view.image) view.image.sha256 = '0'.repeat(64); return view; })() } }) });
  const session = await selected(bad); await assert.rejects(bad.driver.observe(session.sessionId, { includeImage: true }), { code: 'desktop_capture_unavailable' });
  const badCrc = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: (() => {
    const view = raw(request.includeImage); if (view.image) { const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1; view.image.dataBase64 = corrupt.toString('base64'); view.image.sha256 = digest(corrupt); } return view;
  })() } }) });
  const crcSession = await selected(badCrc); await assert.rejects(badCrc.driver.observe(crcSession.sessionId, { includeImage: true }), { code: 'desktop_capture_unavailable' });
});

test('closing a session aborts its owned native action, waits for cleanup and never closes the user application', async () => {
  let actionSignal, stopped = false;
  const h = harness({ transport: async (request, raw, context) => {
    if (request.operation === 'act') return new Promise((_resolve, reject) => {
      actionSignal = context.signal;
      context.signal.addEventListener('abort', () => { stopped = true; reject(Object.assign(new Error('cancelled fake action'), { code: 'desktop_cancelled', cleanup, outcome: 'outcome_unknown' })); }, { once: true });
    });
    return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: raw() } };
  } });
  const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, action(opened.observation));
  const pending = assert.rejects(h.driver.execute(plan.planId), error => error.code === 'desktop_cancelled' && error.outcome === 'outcome_unknown');
  const closed = await h.driver.close(opened.sessionId);
  await pending;
  assert.equal(actionSignal.aborted, true); assert.equal(stopped, true);
  assert.equal(closed.closed, true); assert.equal(closed.applicationClosed, false); assert.equal(closed.cleanup.confirmed, true);
  assert.equal(h.calls.filter(item => item.operation === 'act').length, 1);
  assert.equal((await h.driver.health()).reason, 'quarantined');
});

test('closing an owned read cancels it with confirmed cleanup and preserves future session availability', async () => {
  let pause = false;
  const h = harness({ transport: async (request, raw, context) => {
    if (pause && request.operation === 'observe') return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled fake observation'), { code: 'desktop_cancelled', cleanup })), { once: true }));
    return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : request.operation === 'health' ? { ok: true, engine: 'windows-uia', apartment: 'MTA' } : { ok: true, observation: raw() } };
  } });
  const opened = await selected(h); pause = true;
  const pending = assert.rejects(h.driver.observe(opened.sessionId), { code: 'desktop_cancelled' });
  const closed = await h.driver.close(opened.sessionId); await pending;
  assert.equal(closed.cleanup.confirmed, true); assert.equal((await h.driver.health()).available, true);
});

test('uncertain dispatch/cleanup quarantines the driver and a cancelled plan is never retried', async () => {
  const h = harness({ transport: async (request, raw) => {
    if (request.operation === 'act') throw Object.assign(new Error('fake timeout'), { code: 'desktop_timeout', cleanup, outcome: 'outcome_unknown' });
    return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] } : { ok: true, observation: raw() } };
  } });
  const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, action(opened.observation));
  await assert.rejects(h.driver.execute(plan.planId), error => error.code === 'desktop_timeout' && error.outcome === 'outcome_unknown');
  assert.equal((await h.driver.health()).reason, 'quarantined'); await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_plan_expired' });
  const broken = harness({ transport: async () => ({ ok: true, data: {}, cleanup: { confirmed: false } }) });
  await assert.rejects(broken.driver.listWindows(), { code: 'desktop_cleanup_uncertain' }); assert.equal((await broken.driver.health()).reason, 'quarantined');
  const unstarted = harness(), session = await selected(unstarted), cancelled = unstarted.driver.prepare(session.sessionId, action(session.observation));
  const controller = new AbortController(); controller.abort(); const count = unstarted.calls.length;
  await assert.rejects(unstarted.driver.execute(cancelled.planId, { signal: controller.signal }), { code: 'desktop_cancelled' }); assert.equal(unstarted.calls.length, count);
});

test('native setter and managed exception diagnostics survive errors without exposing exception text or changing unknown semantics', async () => {
  for (const source of ['legacy_set_value','managed_exception']) {
    const diagnostics = { nativePhase: 'set_value_dispatch', dispatchAttempted: true, plannedTextTransport: 'legacy', textTransport: 'legacy',
      nativeHresult: source === 'legacy_set_value' ? -2147467263 : -2146233079, nativeHresultSource: source };
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
      : request.operation === 'act' ? { ok: false, ...diagnostics, exceptionText: 'private label/path must not leak', error: { code: 'desktop_native_failed', message: 'private native exception' } }
      : { ok: true, observation: raw() } }) });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setValue'), value: 'exact approved value' });
    await assert.rejects(h.driver.execute(plan.planId), caught => {
      assert.equal(caught.code, 'desktop_native_failed'); assert.equal(caught.outcome, 'outcome_unknown'); assert.equal(caught.cleanup.confirmed, true);
      for (const [key,value] of Object.entries(diagnostics)) assert.equal(caught[key], value);
      assert.equal(caught.exceptionText, undefined); assert.ok(!caught.message.includes('private')); return true;
    });
    assert.equal((await h.driver.health()).reason, 'quarantined');
    await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_plan_expired' });
  }
  const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
    : request.operation === 'act' ? { ok: false, dispatchAttempted: false, nativePhase: 'set_value_revalidation', plannedTextTransport: 'legacy', error: { code: 'desktop_stale' } }
    : request.operation === 'health' ? { ok: true, engine: 'windows-uia', apartment: 'MTA' } : { ok: true, observation: raw() } }) });
  const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, action(opened.observation));
  await assert.rejects(h.driver.execute(plan.planId), caught => caught.code === 'desktop_stale' && caught.outcome === 'not_dispatched'
    && caught.dispatched === false && caught.dispatchAttempted === false && caught.nativePhase === 'set_value_revalidation' && caught.nativeHresult === undefined && caught.textTransport === undefined);
  assert.equal((await h.driver.health()).available, true);
});

test('malformed native diagnostics fail closed and cannot disguise a possibly dispatched action', async () => {
  const valid = { nativePhase: 'set_value_dispatch', dispatchAttempted: true, plannedTextTransport: 'legacy', textTransport: 'legacy', nativeHresult: -2147467263, nativeHresultSource: 'legacy_set_value' };
  for (const change of [{ nativePhase: 'private path or exception text' }, { nativeHresult: 2147483648 }, { nativeHresult: -2147483649 }, { nativeHresult: '-2147467263' },
    { nativeHresult: 0.1 }, { nativeHresult: null }, { nativeHresult: undefined }, { nativeHresultSource: undefined }, { nativeHresultSource: 'arbitrary error' },
    { dispatchAttempted: 'false' }, { dispatchAttempted: undefined }, { dispatchAttempted: false }, { textTransport: 'WM_SETTEXT' }, { plannedTextTransport: 'keyboard' },
    { plannedTextTransport: 'value' }, { nativePhase: 'set_value_preflight' }, { nativeWin32Error: -1 }, { nativeWin32Error: 0x100000000 }, { nativeWin32Error: '1460' }]) {
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
      : request.operation === 'act' ? { ok: false, ...valid, ...change, error: { code: 'desktop_stale' } } : { ok: true, observation: raw() } }) });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, action(opened.observation));
    await assert.rejects(h.driver.execute(plan.planId), caught => caught.code === 'desktop_protocol' && caught.outcome === 'outcome_unknown'
      && caught.dispatched !== false && caught.cleanup.confirmed === true && !caught.message.includes('private'));
    assert.equal((await h.driver.health()).reason, 'quarantined');
  }
});

test('after-observation failure keeps validated diagnostics and never converts a setter return into outcome proof', async () => {
  for (const nativeHresult of [0, -2147467259]) {
    const diagnostics = { nativePhase: 'after_observation', dispatchAttempted: true, plannedTextTransport: 'legacy', textTransport: 'legacy', nativeHresult,
      nativeHresultSource: nativeHresult === 0 ? 'legacy_set_value' : 'managed_exception' };
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
      : request.operation === 'act' ? { ok: true, dispatched: true, effectState: 'outcome_unknown', ...diagnostics } : { ok: true, observation: raw() } }) });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setValue'), value: 'approved but unverified' });
    const receipt = await h.driver.execute(plan.planId);
    assert.equal(receipt.status, 'outcome_unknown'); assert.equal(receipt.effectObserved, null); assert.equal(receipt.cleanup.confirmed, true);
    for (const [key,value] of Object.entries(diagnostics)) assert.equal(receipt[key], value);
    assert.equal((await h.driver.health()).reason, 'quarantined');
  }
});

test('a complete mismatched text readback is unknown and quarantined even if native reports only input_dispatched', async () => {
  for (const nativeState of ['input_dispatched','outcome_unknown']) {
    const diagnostics = { nativePhase: 'completed', dispatchAttempted: true, plannedTextTransport: 'legacy', textTransport: 'legacy', nativeHresult: 0, nativeHresultSource: 'legacy_set_value' };
    const h = harness({ transport: async (request, raw) => {
      const after = raw();
      const actualValue = 'complete actual value differs';
      Object.assign(after.elements[1], { value: actualValue, valueChars: actualValue.length, valueTruncated: false, valueSha256: digest(actualValue) });
      return { ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
        : request.operation === 'act' ? { ok: true, dispatched: true, effectState: nativeState, ...diagnostics, after } : { ok: true, observation: raw() } };
    } });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, { ...action(opened.observation, 'setValue'), value: 'the exact approved value' });
    const receipt = await h.driver.execute(plan.planId);
    assert.equal(receipt.status, 'outcome_unknown'); assert.equal(receipt.effectObserved, null); assert.equal(receipt.dispatched, true);
    assert.equal(receipt.after.elements[1].value, 'complete actual value differs'); assert.equal(receipt.cleanup.confirmed, true);
    for (const [key,value] of Object.entries(diagnostics)) assert.equal(receipt[key], value);
    assert.equal((await h.driver.health()).reason, 'quarantined');
    await assert.rejects(h.driver.execute(plan.planId), { code: 'desktop_plan_expired' });
    await assert.rejects(h.driver.observe(opened.sessionId), { code: 'desktop_unavailable' });
  }
});

test('forged value proof or missing after observation is outcome unknown, never application success', async () => {
  for (const missingAfter of [true, false]) {
    const h = harness({ transport: async (request, raw) => ({ ok: true, cleanup, data: request.operation === 'list' ? { ok: true, windows: [target] }
      : request.operation === 'act' ? { ok: true, dispatched: true, effectState: missingAfter ? 'input_dispatched' : 'value_verified', ...(missingAfter ? {} : { after: raw() }) }
      : { ok: true, observation: raw() } }) });
    const opened = await selected(h), plan = h.driver.prepare(opened.sessionId, action(opened.observation));
    if (missingAfter) { const result = await h.driver.execute(plan.planId); assert.equal(result.status, 'outcome_unknown'); assert.equal(result.effectObserved, null); }
    else await assert.rejects(h.driver.execute(plan.planId), error => error.code === 'desktop_protocol' && error.outcome === 'outcome_unknown');
    assert.equal((await h.driver.health()).available, false);
  }
});

test('fixed native sources contain the scoped capture/MTA/Job/cancellation boundary and no global input/capture API', async () => {
  const native = await readFile(new URL('../server/desktop/windows-uia.cs', import.meta.url), 'utf8');
  const job = await readFile(new URL('../server/desktop/windows-job.py', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../server/desktop/windows-uia-legacy.cs', import.meta.url), 'utf8');
  assert.ok(native.includes('PrintWindow(window.Hwnd,dc,2)'));
  assert.ok(native.includes('ApartmentState.MTA')); assert.ok(native.includes('current.IsPassword'));
  assert.ok(native.includes('SetThreadDpiAwarenessContext')); assert.ok(native.includes('view.SafetyBlocked'));
  assert.ok(native.includes('view.SafetyBlocked=true')); assert.ok(native.includes('approveButton && rejectButton'));
  assert.ok(native.includes('SetValue(requested)')); assert.ok(native.includes('GetRuntimeId()'));
  assert.ok(native.includes('legacy.Pattern.SetValue(requested)')); assert.ok(legacy.includes('actual.SequenceEqual(expected)'));
  assert.ok(legacy.includes('ReadOnly|Protected|Unavailable|Invisible|Offscreen|Busy'));
  assert.doesNotMatch(native + legacy, /\.DoDefaultAction\s*\(|\.Select\s*\(\s*SELFLAG/);
  assert.ok(native.includes('NativeTextWrite(edit.Hwnd,0x000c,UIntPtr.Zero,requested,0x22,2000,out result)'));
  assert.ok(native.includes('NativeTextRead(edit.Hwnd,0x000d,new UIntPtr(32768)'));
  assert.ok(native.includes('GetAncestor(hwnd,2)!=window.Hwnd')); assert.ok(native.includes('pid!=(uint)window.Process.Pid'));
  assert.ok(native.includes('fromHandle.GetRuntimeId().SequenceEqual(element.GetRuntimeId())'));
  assert.ok(native.includes('new UTF8Encoding(false,true)'));
  assert.ok(native.indexOf('var nativePrivacy=textual ? NativeEditWindow') < native.indexOf('LegacyText legacy=textual ? textScope.Get'));
  assert.doesNotMatch(native, /EntryPoint="(?:SendMessageW|PostMessageW|SetWindowTextW)"/);
  assert.doesNotMatch(native, /\b(?:BitBlt|SendInput|keybd_event|mouse_event|SetForegroundWindow|SetFocus|SendKeys)\s*\(/);
  assert.ok(job.includes('CREATE_SUSPENDED') || job.includes('0x00000004'));
  assert.ok(job.includes('AssignProcessToJobObject')); assert.ok(job.includes('ActiveProcesses == 0'));
  assert.ok(job.includes('cancelled.is_set()')); assert.ok(job.includes('windows-uia.cs'));
});
