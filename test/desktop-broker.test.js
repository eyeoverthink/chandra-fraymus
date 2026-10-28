import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { createDesktopBroker, DESKTOP_LIMITS } from '../server/desktop/broker.js';
import { consumeToolObservation } from '../server/agent/tool-observation.js';
import { crc32 } from '../server/transport/rgba.js';
import { assertSchema } from '../server/agent/schema.js';

// Every native operation is injected. This file never opens a user window,
// captures a desktop, contacts a model/network, or starts a native process.
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function chunk(tag, bytes) {
  const type = Buffer.from(tag), result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), result.length - 4);
  return result;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 20, 100, 200, 255]))), chunk('IEND', Buffer.alloc(0))]);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { overrides = {}, verifiedVisionModels = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  let clock = 1000000;
  const calls = { open: [], observe: [], prepare: [], execute: [], close: [] };
  const receipts = [], revocations = [];
  const nativePlans = new Map();
  function snapshot(includeImage = false, elements = 3) {
    return { snapshotId: randomUUID(), fingerprint: sha('synthetic snapshot ' + randomUUID()),
      window: { title: 'Synthetic fixture only', app: 'FraymusDesktopFixture.exe' },
      elements: Array.from({ length: elements }, (_, index) => ({ elementId: 'element-' + index,
        role: index === 1 ? 'Edit' : index === 2 ? 'Pane' : 'Button', name: 'Synthetic element ' + index,
        ...(index === 1 ? { value: 'test-only value' } : {}), enabled: true,
        patterns: [index === 1 ? 'setValue' : index === 2 ? 'scroll' : 'invoke'] })), truncated: false,
      ...(includeImage ? { image: { bytes: Buffer.from(png), mimeType: 'image/png', width: 1, height: 1 } } : {}) };
  }
  const driver = {
    health: async () => ({ configured: true, available: true, engine: 'windows-uia' }),
    listWindows: async () => ({ windows: [{ windowId: 'synthetic-window', title: 'Synthetic fixture only', app: 'FraymusDesktopFixture.exe' }] }),
    openSession: async (input, options) => {
      calls.open.push({ input: copy(input), options });
      return overrides.openSession ? overrides.openSession(input, options)
        : { sessionId: 'native-' + randomUUID(), window: { title: 'Synthetic fixture only', app: 'FraymusDesktopFixture.exe' } };
    },
    observe: async (id, options) => {
      calls.observe.push({ id, options });
      return overrides.observe ? overrides.observe(id, options, snapshot) : snapshot(options.includeImage);
    },
    prepare: async (id, args) => {
      calls.prepare.push({ id, args: copy(args) });
      if (overrides.prepare) return overrides.prepare(id, args);
      const planId = randomUUID(); nativePlans.set(planId, copy(args));
      return { planId, preview: Object.freeze({ expiresAt: clock + 180000, operation: args.operation,
        ...(args.value !== undefined ? { value: args.value } : {}),
        target: Object.freeze({ elementId: args.elementId, role: ['setValue','setNativeText'].includes(args.operation) ? 'Edit' : 'Button', name: 'Synthetic target' }) }) };
    },
    execute: async (id, options) => {
      calls.execute.push({ id, options });
      if (overrides.execute) return overrides.execute(id, options, snapshot);
      const args = nativePlans.get(id);
      return { status: ['setValue','setNativeText'].includes(args.operation) ? 'value_verified' : 'input_dispatched',
        after: snapshot(), cleanup: { confirmed: true, remainingProcesses: 0 } };
    },
    close: async id => { calls.close.push(id); return { ok: true, cleanup: { confirmed: true, remainingProcesses: 0 } }; },
  };
  const broker = createDesktopBroker({ db, driver, now: () => clock, verifiedVisionModels,
    onReceipt: (id, receipt) => receipts.push({ runId: id, receipt: copy(receipt) }),
    onRevoke: (id, state) => { revocations.push({ runId: id, state });overrides.onRevoke?.(id,state); } });
  t.after(async () => { await broker.close(); await turn(); db.close(); });
  const tools = Object.fromEntries(broker.tools().map(tool => [tool.name, tool]));
  let counter = 0;
  async function selected({ allowScreenshots = false } = {}) {
    const grant = await broker.createSession({ requestId: 'grant-' + ++counter, windowId: 'synthetic-window', allowScreenshots });
    const run = { id: 'run-' + counter, provider: 'ollama', allowCloud: false, model: 'synthetic-vision-model',
      desktopSessionId: grant.sessionId, budget: { maxToolResultChars: 12000 } };
    broker.claim(grant.sessionId, run);
    return { grant, run };
  }
  const context = (run, args = {}, extra = {}) => ({ run, args, signal: new AbortController().signal,
    modelCapabilities: { vision: true, tools: true }, ...extra });
  const call = (name, run, args = {}, extra = {}) => tools[name].execute(context(run, args, extra));
  async function planned(run, operation = 'invoke') {
    const observed = await call('desktop.observe', run);
    const element = observed.elements.find(item => item.patterns.includes(operation));
    const args = { snapshotId: observed.snapshotId, elementId: element.elementId,
      ...(['setValue','setNativeText'].includes(operation) ? { value: 'Literal $(); draft\nsecond line' } : {}),
      ...(operation === 'scroll' ? { vertical: 'smallIncrement' } : {}) };
    const name = { setValue: 'desktop.planValue', setNativeText: 'desktop.planNativeText', invoke: 'desktop.planInvoke', scroll: 'desktop.planScroll' }[operation];
    const plan = await call(name, run, args);
    return { observed, args, plan };
  }
  const actionRows = () => db.prepare('SELECT * FROM agent_desktop_actions ORDER BY created_at,id').all().map(row => {
    assert.equal(sha(row.record_json), row.record_hash);
    return JSON.parse(row.record_json);
  });
  return { broker, db, driver, calls, receipts, revocations, snapshot, selected, context, call, planned, tools, actionRows,
    tick: amount => { clock += amount; } };
}

test('desktop grant creation is idempotent after a lost response and rejects changed request input', async t => {
  const f = fixture(t), input = { requestId: 'lost-response', windowId: 'synthetic-window', allowScreenshots: false };
  const first = await f.broker.createSession(input);
  assert.deepEqual(await f.broker.createSession(input), first);
  assert.equal(f.calls.open.length, 1);
  const recovered = f.broker.request(input.requestId);
  assert.equal(recovered.state, 'created'); assert.equal(recovered.session.sessionId, first.sessionId);
  await assert.rejects(f.broker.createSession({ ...input, allowScreenshots: true }), { code: 'desktop_grant_conflict', status: 409 });
  assert.equal(f.calls.open.length, 1);
});

test('simultaneous identical grant requests recover the same creation instead of a uniqueness error', async t => {
  const f = fixture(t), input = { requestId: 'simultaneous-create', windowId: 'synthetic-window', allowScreenshots: false };
  const results = await Promise.all([f.broker.createSession(input), f.broker.createSession({ ...input })]);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal(f.calls.open.length, 1);
});

test('revoke of an inflight grant creation prevents recovered late authority and closes the owned native session', async t => {
  const opening = deferred();
  const f = fixture(t, { overrides: { openSession: () => opening.promise } });
  const input = { requestId: 'opening-revoked', windowId: 'synthetic-window', allowScreenshots: false };
  const first = f.broker.createSession(input);
  await turn(); assert.equal(f.calls.open.length, 1);
  const repeated = f.broker.createSession(input);
  assert.equal(f.broker.request(input.requestId).state, 'creating');
  assert.equal((await f.broker.revokeRequest(input.requestId)).state, 'revoked');
  opening.resolve({ sessionId: 'native-open-late', window: { title: 'Synthetic fixture only' } });
  const [one, two] = await Promise.all([first, repeated]);
  assert.equal(one.sessionId, two.sessionId); assert.equal(one.state, 'revoked');
  assert.deepEqual(f.calls.close, ['native-open-late']);
  assert.equal((await f.broker.createSession(input)).state, 'revoked');
  assert.equal(f.broker.request(input.requestId).state, 'revoked');
});

test('concurrent distinct creates reserve the session quota while native selection is pending', async t => {
  const openings = [];
  const f = fixture(t, { overrides: { openSession: () => { const pending = deferred(); openings.push(pending); return pending.promise; } } });
  const attempts = Array.from({ length: DESKTOP_LIMITS.maxSessions + 1 }, (_, index) => f.broker.createSession({
    requestId: 'parallel-grant-' + index, windowId: 'synthetic-window', allowScreenshots: false,
  }));
  const settled = Promise.allSettled(attempts);
  await turn();
  for (let index = 0; index < openings.length; index++) openings[index].resolve({ sessionId: 'native-parallel-' + index, window: {} });
  const results = await settled;
  assert.equal(results.filter(item => item.status === 'fulfilled').length, DESKTOP_LIMITS.maxSessions);
  assert.equal(f.calls.open.length, DESKTOP_LIMITS.maxSessions, 'the quota must be reserved before another native selection starts');
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'desktop_busy');
});

test('broker shutdown revokes pending selections so late creation cannot restore desktop authority', async t => {
  const opening = deferred();
  const f = fixture(t, { overrides: { openSession: () => opening.promise } });
  const pending = f.broker.createSession({ requestId: 'shutdown-during-create', windowId: 'synthetic-window', allowScreenshots: false });
  const settled = Promise.allSettled([pending]);
  await turn(); assert.equal(f.calls.open.length, 1);
  const closing = f.broker.close();
  opening.resolve({ sessionId: 'native-after-shutdown', window: {} });
  const [result] = await settled;
  await closing;
  if (result.status === 'fulfilled') assert.notEqual(result.value.state, 'active', 'a closed broker must not recover an active desktop grant');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agent_desktop_grants WHERE state='active'").get().n, 0);
  assert.ok(f.calls.close.includes('native-after-shutdown'));
});

test('desktop claims and snapshot reads/plans enforce exact local run and selected-session ownership', async t => {
  const f = fixture(t), first = await f.selected(), second = await f.selected();
  const observed = await f.call('desktop.observe', first.run);
  assert.throws(() => f.broker.claim(first.grant.sessionId, second.run), { code: 'desktop_busy' });
  assert.throws(() => f.broker.claim(second.grant.sessionId, { ...second.run, provider: 'openai', allowCloud: true }), { code: 'desktop_local_only' });
  for (const changed of [{ id: 'another-run' }, { allowCloud: true }, { provider: 'openai' }, { desktopSessionId: second.grant.sessionId }]) {
    await assert.rejects(f.call('desktop.observe', { ...first.run, ...changed }), { code: 'desktop_scope_denied' });
  }
  await assert.rejects(f.call('desktop.read', second.run, { snapshotId: observed.snapshotId }), { code: 'desktop_snapshot_denied' });
  await assert.rejects(f.call('desktop.planInvoke', second.run, { snapshotId: observed.snapshotId, elementId: observed.elements[0].elementId }), { code: 'desktop_snapshot_denied' });
  assert.equal(f.calls.observe.length, 1); assert.equal(f.calls.prepare.length, 0);
});

test('image input stays unavailable with no verified model and rejects before any native capture', async t => {
  const f = fixture(t), { run } = await f.selected({ allowScreenshots: true });
  const health = await f.broker.health();
  assert.equal(health.screenshotModelInputVerified, false); assert.deepEqual(health.verifiedVisionModels, []);
  assert.equal(health.isolation, 'none'); assert.equal(health.localOnly, true);
  await assert.rejects(f.call('desktop.observe', run, { includeImage: true }), { code: 'desktop_vision_unverified' });
  assert.equal(f.calls.observe.length, 0);
  const textOnly = await f.call('desktop.observe', run);
  assert.ok(textOnly.elements.length); assert.equal(f.calls.observe[0].options.includeImage, false);
});

test('fake verified image path still requires per-grant consent and vision metadata before capture', async t => {
  const f = fixture(t, { verifiedVisionModels: ['synthetic-vision-model'] });
  const noConsent = await f.selected(), consent = await f.selected({ allowScreenshots: true });
  await assert.rejects(f.call('desktop.observe', noConsent.run, { includeImage: true }), { code: 'desktop_vision_unverified' });
  await assert.rejects(f.call('desktop.observe', consent.run, { includeImage: true }, { modelCapabilities: { vision: false } }), { code: 'desktop_vision_unverified' });
  await assert.rejects(f.call('desktop.observe', { ...consent.run, model: 'unverified-model' }, { includeImage: true }), { code: 'desktop_vision_unverified' });
  assert.equal(f.calls.observe.length, 0);
  const envelope = await f.call('desktop.observe', consent.run, { includeImage: true });
  const consumed = consumeToolObservation(envelope, { run: consent.run, metadata: { vision: true }, provider: 'ollama' });
  assert.equal(consumed.images.length, 1); assert.equal(sha(Buffer.from(consumed.images[0].data, 'base64')), sha(png));
  const row = f.db.prepare('SELECT * FROM agent_desktop_snapshots').get();
  assert.doesNotMatch(row.record_json, new RegExp(png.toString('base64')));
  assert.equal(JSON.parse(row.record_json).image.sha256, sha(png));
  f.db.prepare('UPDATE agent_desktop_snapshots SET image=? WHERE id=?').run(Buffer.from('tampered image'), row.id);
  assert.throws(() => f.broker.image(row.id), { code: 'desktop_integrity' });
});

test('human preview retains an isolated image without enabling model screenshots or a typed image envelope', async t => {
  const f = fixture(t), grant = await f.broker.createSession({ requestId: 'human-preview',
    windowId: 'synthetic-window', allowScreenshots: false });
  const preview = await f.broker.preview(grant.sessionId);
  assert.equal(preview.operatorPreview, true); assert.equal(preview.untrusted, true);
  assert.equal(f.calls.observe.length, 1); assert.equal(f.calls.observe[0].options.includeImage, true);
  assert.deepEqual({ width: preview.image.width, height: preview.image.height, mimeType: preview.image.mimeType },
    { width: 1, height: 1, mimeType: 'image/png' });
  assert.equal(preview.image.url, `/api/desktop/snapshots/${preview.snapshotId}/image`);
  assert.equal(preview.image.sha256, sha(png)); assert.equal(preview.image.bytes, png.length);
  assert.equal(sha(f.broker.image(preview.snapshotId)), preview.image.sha256,
    'the human image-route backing bytes match the advertised immutable hash');
  const row = f.db.prepare('SELECT * FROM agent_desktop_snapshots WHERE id=?').get(preview.snapshotId);
  assert.equal(row.run_id, 'operator-preview:' + grant.sessionId); assert.equal(row.session_id, grant.sessionId);
  assert.equal(sha(row.record_json), row.record_hash);
  const unchanged = f.broker.session(grant.sessionId);
  assert.equal(unchanged.allowScreenshots, false); assert.equal(unchanged.activeRunId, null);
  assert.deepEqual((await f.broker.health()).verifiedVisionModels, []);
  const run = { id: 'regular-preview-denied', provider: 'ollama', allowCloud: false,
    model: 'synthetic-vision-model', desktopSessionId: grant.sessionId, budget: { maxToolResultChars: 12000 } };
  const consumed = consumeToolObservation(preview, { run, metadata: { vision: true }, provider: 'ollama' });
  assert.deepEqual(consumed.images, []); assert.equal(consumed.result, preview);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(png.toString('base64')));
  f.broker.claim(grant.sessionId, run);
  await assert.rejects(f.call('desktop.read', run, { snapshotId: preview.snapshotId }), { code: 'desktop_snapshot_denied' });
  await assert.rejects(f.call('desktop.observe', run, { includeImage: true }), { code: 'desktop_vision_unverified' });
  assert.equal(f.calls.observe.length, 1);
});

test('human preview rejects an active run before capture and leaves its pending semantic plan usable', async t => {
  const f = fixture(t), { grant, run } = await f.selected(), { observed, plan } = await f.planned(run);
  const beforeCaptures = f.calls.observe.length;
  await assert.rejects(f.broker.preview(grant.sessionId), { code: 'desktop_busy', status: 409 });
  assert.equal(f.calls.observe.length, beforeCaptures, 'preview must not invalidate an active run snapshot');
  const acted = await f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'approved-existing-plan' });
  assert.equal(acted.status, 'input_dispatched'); assert.equal(acted.beforeSnapshotId, observed.snapshotId);
  assert.equal(f.calls.execute.length, 1); assert.equal(f.broker.session(grant.sessionId).allowScreenshots, false);
});

test('human preview revocation or cancellation rejects a late frame and retains no pixels or stale authority', async t => {
  for (const mode of ['revoke', 'signal']) {
    const capturing = deferred(), controller = new AbortController();
    const f = fixture(t, { overrides: { observe: () => capturing.promise } });
    const grant = await f.broker.createSession({ requestId: 'pending-human-preview-' + mode,
      windowId: 'synthetic-window', allowScreenshots: false });
    const pending = f.broker.preview(grant.sessionId, { signal: controller.signal });
    await turn(); assert.equal(f.calls.observe.length, 1);
    await assert.rejects(f.broker.preview(grant.sessionId), { code: 'desktop_busy' });
    assert.throws(() => f.broker.claim(grant.sessionId, { id: 'run-during-preview', provider: 'ollama', allowCloud: false }), { code: 'desktop_busy' });
    if (mode === 'revoke') await f.broker.revoke(grant.sessionId);
    else controller.abort(new Error('Synthetic human preview cancellation'));
    assert.equal(f.calls.observe[0].options.signal.aborted, true);
    capturing.resolve(f.snapshot(true));
    if (mode === 'revoke') await assert.rejects(pending, { code: 'desktop_session_inactive' });
    else await assert.rejects(pending, /Synthetic human preview cancellation/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_desktop_snapshots').get().n, 0);
    assert.equal(f.broker.session(grant.sessionId).allowScreenshots, false);
    assert.equal(f.calls.observe.length, 1);
    if (mode === 'signal') {
      f.broker.claim(grant.sessionId, { id: 'run-after-cancelled-preview', provider: 'ollama', allowCloud: false });
      assert.equal(f.broker.session(grant.sessionId).activeRunId, 'run-after-cancelled-preview', 'cancelled preview releases its busy flag');
    }
  }
});

test('frozen semantic plans require an approval ID and execute only once with durable exact receipts', async t => {
  const f = fixture(t), { run } = await f.selected(), { args, plan } = await f.planned(run, 'setValue');
  assert.equal(f.calls.execute.length, 0);
  assert.equal(f.calls.prepare[0].args.operation, 'setValue');
  assert.deepEqual(f.calls.prepare[0].args, { ...args, operation: 'setValue' });
  const preview = await f.tools['desktop.act'].prepare(f.context(run, { planId: plan.planId }));
  assert.equal(preview.value, args.value); assert.equal(preview.sessionId, run.desktopSessionId);
  await assert.rejects(f.call('desktop.act', run, { planId: plan.planId }), { code: 'desktop_plan_invalid' });
  assert.equal(f.calls.execute.length, 0);
  const result = await f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'exact-core-approval' });
  assert.equal(result.status, 'value_verified'); assert.equal(result.effectObserved, true);
  assert.equal(result.receipt.approvalId, 'exact-core-approval'); assert.equal(result.value, args.value);
  assert.equal(result.engine, 'windows-uia'); assert.equal(result.isolation, 'none');
  assert.equal(f.actionRows().length, 1); assert.deepEqual(f.actionRows()[0], result.receipt);
  assert.deepEqual(f.receipts.map(item => item.receipt.status), ['outcome_unknown', 'value_verified']);
  await assert.rejects(f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'different-approval' }), { code: 'desktop_plan_invalid' });
  assert.equal(f.calls.execute.length, 1);
});

test('native Edit text replacement is a separately observed and approved operation with no message or target arguments', async t => {
  const f=fixture(t,{overrides:{
    observe:async(_id,_options,snapshot)=>{const value=snapshot();value.elements[1].patterns=['setNativeText'];
      value.elements[1].nativeText={className:'WindowsForms10.EDIT.app.0.test',method:'WM_SETTEXT',timeoutMs:2000,maxTextBytes:65536,hwnd:'private-native-handle'};
      value.elements[1].nativeEdit={hwnd:'private-native-handle',pid:999,style:123};return value;},
    execute:async(_id,_options,snapshot)=>({status:'value_verified',after:snapshot(),nativePhase:'completed',
      dispatchAttempted:true,plannedTextTransport:'win32_edit',textTransport:'win32_edit',cleanup:{confirmed:true,remainingProcesses:0}})
  }});
  const {run}=await f.selected(),{observed,args,plan}=await f.planned(run,'setNativeText');
  assert.deepEqual(observed.elements[1].nativeText,{className:'WindowsForms10.EDIT.app.0.test',method:'WM_SETTEXT',timeoutMs:2000,maxTextBytes:65536});
  assert.doesNotMatch(JSON.stringify(observed),/private-native-handle|nativeEdit/);
  assert.equal(plan.preview.operation,'setNativeText');assert.equal(plan.preview.value,args.value);
  assert.equal(f.calls.prepare[0].args.operation,'setNativeText');assert.equal(f.calls.execute.length,0);
  await assert.rejects(f.call('desktop.planValue',run,args),{code:'desktop_pattern_unsupported'});
  for(const extra of [{hwnd:'123'},{message:12},{operation:'setValue'},{executable:'other.exe'}]) {
    assert.throws(()=>assertSchema({...args,...extra},f.tools['desktop.planNativeText'].parameters),{code:'invalid_arguments'});
  }
  await assert.rejects(f.call('desktop.act',run,{planId:plan.planId}),{code:'desktop_plan_invalid'});
  const result=await f.call('desktop.act',run,{planId:plan.planId},{approvalId:'exact-native-text'});
  assert.equal(result.status,'value_verified');assert.equal(result.textTransport,'win32_edit');
  assert.equal(result.dispatchAttempted,true);assert.equal(result.pending,false);assert.equal(result.beforeSnapshotId,observed.snapshotId);
  await assert.rejects(f.call('desktop.act',run,{planId:plan.planId},{approvalId:'cannot-retry'}),{code:'desktop_plan_invalid'});
  assert.equal(f.calls.execute.length,1);
  const unsupported=fixture(t),other=await unsupported.selected(),view=await unsupported.call('desktop.observe',other.run);
  await assert.rejects(unsupported.call('desktop.planNativeText',other.run,{snapshotId:view.snapshotId,elementId:view.elements[1].elementId,value:'never sent'}),{code:'desktop_pattern_unsupported'});
  assert.equal(unsupported.calls.prepare.length,0);assert.equal(unsupported.calls.execute.length,0);
});

test('a timed-out native Edit action retains Win32 diagnostics and quarantines without using the semantic setter', async t => {
  const f=fixture(t,{overrides:{
    observe:async(_id,_options,snapshot)=>{const value=snapshot();value.elements[1].patterns=['setNativeText'];return value;},
    execute:async()=>{throw Object.assign(new Error('fixed native timeout'),{code:'desktop_timeout',outcome:'outcome_unknown',
      nativePhase:'native_text_dispatch',nativeWin32Error:1460,dispatchAttempted:true,
      plannedTextTransport:'win32_edit',textTransport:'win32_edit',cleanup:{confirmed:true,remainingProcesses:0}});}
  }});
  const {run,grant}=await f.selected(),{plan}=await f.planned(run,'setNativeText');
  const result=await f.call('desktop.act',run,{planId:plan.planId},{approvalId:'native-timeout-approval'});
  assert.equal(result.status,'outcome_unknown');assert.equal(result.nativeWin32Error,1460);
  assert.equal(result.nativePhase,'native_text_dispatch');assert.equal(result.textTransport,'win32_edit');
  assert.equal(f.broker.session(grant.sessionId).state,'quarantined');
  assert.equal(f.calls.prepare[0].args.operation,'setNativeText');assert.equal(f.calls.execute.length,1);
});

test('operation-specific planners reject irrelevant model fields and preserve exact scroll semantics', async t => {
  const f = fixture(t), { run } = await f.selected();
  assert.equal(f.tools['desktop.plan'], undefined);
  assert.throws(() => assertSchema({ snapshotId: randomUUID(), elementId: 'edit', value: 'draft',
    horizontal: 'none', vertical: 'none' }, f.tools['desktop.planValue'].parameters), { code: 'invalid_arguments' });
  assert.throws(() => assertSchema({ snapshotId: randomUUID(), elementId: 'button', value: 'irrelevant' },
    f.tools['desktop.planInvoke'].parameters), { code: 'invalid_arguments' });
  assert.equal(f.calls.prepare.length, 0);
  const { observed, args, plan } = await f.planned(run, 'scroll');
  assert.deepEqual(f.calls.prepare[0].args, { ...args, operation: 'scroll' });
  assert.equal(Object.hasOwn(args, 'operation'), false); assert.equal(Object.hasOwn(args, 'value'), false);
  const receipt = await f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'exact-scroll-approval' });
  assert.equal(receipt.operation, 'scroll'); assert.equal(receipt.vertical, 'smallIncrement');
  assert.equal(receipt.horizontal, 'none'); assert.equal(receipt.status, 'input_dispatched');
  assert.equal(receipt.effectObserved, null); assert.equal(Object.hasOwn(receipt, 'value'), false);
  await assert.rejects(f.call('desktop.planValue', run, { snapshotId: observed.snapshotId,
    elementId: observed.elements[0].elementId, value: 'wrong pattern' }), { code: 'desktop_pattern_unsupported' });
  assert.equal(f.calls.prepare.length, 1, 'incompatible observed patterns must fail before native preparation');
});

test('another owning run cannot approve or execute the first run plan', async t => {
  const f = fixture(t), first = await f.selected(), second = await f.selected(), { plan } = await f.planned(first.run);
  await assert.rejects(f.tools['desktop.act'].prepare(f.context(second.run, { planId: plan.planId })), { code: 'desktop_plan_invalid' });
  await assert.rejects(f.call('desktop.act', second.run, { planId: plan.planId }, { approvalId: 'other-run-approval' }), { code: 'desktop_plan_invalid' });
  assert.equal(f.calls.execute.length, 0); assert.equal(f.actionRows().length, 0);
});

test('confirmed stale or denied actions keep grant usable but consume the old plan without claiming dispatch', async t => {
  for (const code of ['desktop_stale', 'desktop_denied']) {
    const f = fixture(t, { overrides: { execute: async () => { throw Object.assign(new Error('synthetic pre-dispatch rejection'), { code, outcome: 'not_dispatched' }); } } });
    const { grant, run } = await f.selected(), { plan } = await f.planned(run);
    const result = await f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'approved-stale-plan' });
    assert.equal(result.status, code === 'desktop_denied' ? 'denied' : 'stale'); assert.equal(result.effectObserved, null);
    assert.equal(f.broker.session(grant.sessionId).state, 'active'); assert.deepEqual(f.revocations, []);
    assert.equal(f.actionRows()[0].status, result.status);
    await assert.rejects(f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'replay' }), { code: 'desktop_plan_invalid' });
  }
});

test('uncertain action errors persist outcome_unknown and quarantine the selected grant', async t => {
  const f = fixture(t, { overrides: { execute: async () => { throw Object.assign(new Error('synthetic native timeout'), {
    code: 'desktop_timeout', outcome: 'outcome_unknown', cleanup: { confirmed: false } }); } } });
  const { grant, run } = await f.selected(), { plan } = await f.planned(run);
  const result = await f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'approved-uncertain-action' });
  assert.equal(result.status, 'outcome_unknown'); assert.equal(result.effectObserved, null);
  assert.equal(f.broker.session(grant.sessionId).state, 'quarantined');
  assert.deepEqual(f.revocations, [{ runId: run.id, state: 'quarantined' }]); assert.equal(f.calls.close.length, 1);
  assert.equal(f.actionRows()[0].status, 'outcome_unknown');
  await assert.rejects(f.call('desktop.observe', run), { code: 'desktop_session_inactive' });
});

test('revoke aborts an active observation and rejects its late snapshot without retaining it', async t => {
  const observing = deferred();
  const f = fixture(t, { overrides: { observe: () => observing.promise } });
  const { grant, run } = await f.selected(), pending = f.call('desktop.observe', run);
  await turn(); const nativeSignal = f.calls.observe[0].options.signal;
  const revoked = await f.broker.revoke(grant.sessionId);
  assert.equal(revoked.cleanup.confirmed, true);
  assert.equal(nativeSignal.aborted, true); assert.deepEqual(f.revocations, [{ runId: run.id, state: 'revoked' }]);
  observing.resolve(f.snapshot());
  await assert.rejects(pending, { code: 'desktop_session_inactive' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_desktop_snapshots').get().n, 0);
});

test('expiry cancels an active action and records its late success as unknown instead of verified', async t => {
  const execution = deferred();
  const f = fixture(t, { overrides: { execute: () => execution.promise } });
  const { grant, run } = await f.selected(), { plan } = await f.planned(run);
  const pending = f.call('desktop.act', run, { planId: plan.planId }, { approvalId: 'approved-before-expiry' });
  await turn(); assert.equal(f.actionRows()[0].status, 'outcome_unknown');
  f.tick(DESKTOP_LIMITS.idleMs + 1);
  assert.equal(f.broker.session(grant.sessionId).state, 'expired');
  assert.equal(f.calls.execute[0].options.signal.aborted, true);
  execution.resolve({ status: 'value_verified', after: f.snapshot(), cleanup: { confirmed: true } });
  const result = await pending;
  assert.equal(result.status, 'outcome_unknown'); assert.equal(f.actionRows()[0].status, 'outcome_unknown');
  assert.equal(f.receipts.some(item => item.receipt.status === 'value_verified'), false);
  assert.deepEqual(f.revocations, [{ runId: run.id, state: 'expired' }]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_desktop_snapshots').get().n, 1);
});

test('run cancellation persists a durable unknown receipt even when native execution resolves late', async t => {
  const execution = deferred(), controller = new AbortController();
  const f = fixture(t, { overrides: { execute: () => execution.promise } });
  const { grant, run } = await f.selected(), { plan } = await f.planned(run);
  const pending = f.call('desktop.act', run, { planId: plan.planId }, { signal: controller.signal, approvalId: 'approved-before-cancel' });
  await turn(); const actionId = f.actionRows()[0].actionId;
  assert.equal(f.actionRows()[0].pending,true);
  controller.abort(new Error('Synthetic run cancellation'));
  assert.equal(f.calls.execute[0].options.signal.aborted, true);
  execution.resolve({ status: 'value_verified', after: f.snapshot(), cleanup: { confirmed: true },
    nativePhase: 'completed', dispatchAttempted: true, plannedTextTransport: 'legacy', textTransport: 'legacy' });
  await assert.rejects(pending, /Synthetic run cancellation/);
  const persisted = f.actionRows(); assert.equal(persisted.length, 1); assert.equal(persisted[0].actionId, actionId);
  assert.equal(persisted[0].status, 'outcome_unknown'); assert.equal(persisted[0].effectObserved, null);
  assert.equal(persisted[0].pending,false);
  assert.equal(persisted[0].cleanup.confirmed,true); assert.equal(persisted[0].nativePhase,'completed');
  assert.equal(persisted[0].dispatchAttempted,true); assert.equal(persisted[0].textTransport,'legacy');
  assert.equal(f.receipts.some(item => item.receipt.status === 'value_verified'), false);
  assert.equal(f.broker.session(grant.sessionId).state, 'quarantined');
});

test('native failure diagnostics survive quarantine aborting the run before ordinary tool handling', async t => {
  const controller=new AbortController();
  let f;
  f=fixture(t,{overrides:{
    execute:async()=>{throw Object.assign(new Error('private provider exception text must not be journaled'),{
      code:'desktop_native_failed',outcome:'outcome_unknown',nativePhase:'set_value_dispatch',
      nativeHresult:-2147467263,nativeHresultSource:'legacy_set_value',dispatchAttempted:true,
      plannedTextTransport:'legacy',textTransport:'legacy',cleanup:{confirmed:true,remainingProcesses:0}
    });},
    onRevoke:()=>{assert.equal(f.actionRows()[0].nativeHresult,-2147467263);controller.abort(new Error('Synthetic terminal run'));}
  }});
  const {grant,run}=await f.selected(),{plan}=await f.planned(run,'setValue');
  await assert.rejects(f.call('desktop.act',run,{planId:plan.planId},{approvalId:'exact-diagnostic-approval',signal:controller.signal}),{code:'desktop_native_failed'});
  const record=f.actionRows()[0];
  assert.equal(record.status,'outcome_unknown');assert.equal(record.failureCode,'desktop_native_failed');
  assert.equal(record.nativePhase,'set_value_dispatch');assert.equal(record.nativeHresultSource,'legacy_set_value');
  assert.equal(record.dispatchAttempted,true);assert.equal(record.textTransport,'legacy');
  assert.equal(record.cleanup.confirmed,true);assert.equal(controller.signal.aborted,true);
  assert.doesNotMatch(JSON.stringify(record),/private provider exception/);
  assert.equal(f.broker.session(grant.sessionId).state,'quarantined');
  await assert.rejects(f.call('desktop.act',run,{planId:plan.planId},{approvalId:'cannot-retry'}),{code:'desktop_session_inactive'});
  assert.equal(f.calls.execute.length,1);
});

test('readback failures retain bounded native facts and malformed fields do not leak into receipts', async t => {
  for (const malformed of [false,true]) {
    const f=fixture(t,{overrides:{execute:async()=>({status:'outcome_unknown',cleanup:{confirmed:true},
      nativePhase:malformed?'arbitrary native prose':'after_observation',
      nativeHresult:malformed?2147483648:-2146233079,
      nativeHresultSource:malformed?'untrusted arbitrary source':'managed_exception',
      dispatchAttempted:malformed?'true':true,plannedTextTransport:malformed?'keys':'legacy',
      textTransport:malformed?'global-input':'legacy',privateDetail:'not a protocol field'})}});
    const {run}=await f.selected(),{plan}=await f.planned(run,'setValue');
    const result=await f.call('desktop.act',run,{planId:plan.planId},{approvalId:'readback-diagnostic'});
    const record=f.actionRows()[0];
    assert.equal(record.status,'outcome_unknown');assert.equal(record.effectObserved,null);
    assert.equal(record.nativePhase,malformed?undefined:'after_observation');
    assert.equal(record.nativeHresult,malformed?undefined:-2146233079);
    assert.equal(record.dispatchAttempted,malformed?undefined:true);
    assert.equal(record.textTransport,malformed?undefined:'legacy');
    assert.equal(result.receipt.actionId,record.actionId);
    assert.doesNotMatch(JSON.stringify(record),/arbitrary|privateDetail|global-input/);
  }
});

test('snapshot integrity, result pagination and storage quota prevent silent truncation or corrupted reuse', async t => {
  const f = fixture(t), { run } = await f.selected(), observed = await f.call('desktop.observe', run);
  const page = await f.call('desktop.read', run, { snapshotId: observed.snapshotId, offset: 1, maxElements: 1 });
  assert.equal(page.elements.length, 1); assert.equal(page.offset, 1); assert.equal(page.nextOffset, 2);
  await assert.rejects(f.call('desktop.read', run, { snapshotId: observed.snapshotId, offset: 4 }), { code: 'desktop_offset' });
  await assert.rejects(f.call('desktop.read', { ...run, budget: { maxToolResultChars: 256 } }, { snapshotId: observed.snapshotId }), { code: 'desktop_result_budget' });
  const row = f.db.prepare('SELECT * FROM agent_desktop_snapshots WHERE id=?').get(observed.snapshotId);
  f.db.prepare('UPDATE agent_desktop_snapshots SET record_json=? WHERE id=?').run(row.record_json + ' ', row.id);
  await assert.rejects(f.call('desktop.read', run, { snapshotId: observed.snapshotId }), { code: 'desktop_integrity' });
  await assert.rejects(f.call('desktop.planInvoke', run, { snapshotId: observed.snapshotId, elementId: observed.elements[0].elementId }), { code: 'desktop_integrity' });
  f.db.prepare('UPDATE agent_desktop_snapshots SET record_json=? WHERE id=?').run(row.record_json, row.id);
  for (let index = 1; index < DESKTOP_LIMITS.maxSnapshotsPerRun; index++) await f.call('desktop.observe', run);
  await assert.rejects(f.call('desktop.observe', run), { code: 'desktop_storage_limit' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_desktop_snapshots WHERE run_id=?').get(run.id).n, DESKTOP_LIMITS.maxSnapshotsPerRun);
  assert.equal((await f.call('desktop.read', run, { snapshotId: observed.snapshotId })).snapshotId, observed.snapshotId);
});
