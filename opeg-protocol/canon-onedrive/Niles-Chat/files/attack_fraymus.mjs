// attack_fraymus.mjs — independently attack THEIR verifyWasm.
//
// Runs the real cloud-copy source (not a reimplementation) and tries to make a
// tampered payload pass. If a single flipped byte still returns valid:true, the
// §6.4 hole is open. Any other result means it is closed.
//
// Usage: node attack_fraymus.mjs

import { transmute, decodeWasmFile, verifyWasm } from './src/lib/fraymus.js';
import { buildClassicWasm } from './src/lib/forge.js';

const enc = new TextEncoder();
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// A File-like shim; transmute() only needs .text()/.arrayBuffer()/.name.
const mkFile = (bytes, name) => ({
  name,
  size: bytes.length,
  type: 'application/octet-stream',
  async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
  async text() { return new TextDecoder().decode(bytes); },
});

console.log('\n' + '='.repeat(78));
console.log('  ATTACK: can a tampered payload still verify as valid?');
console.log('='.repeat(78));

// ---- 1. clean round trip ----------------------------------------------------
const PAYLOAD = enc.encode('FRAYMUS TRANSMUTER PAYLOAD\n'.repeat(40));
const file = mkFile(PAYLOAD, 'payload.bin');

let clean;
try {
  clean = await transmute(file);
} catch (e) {
  check('transmute() ran', false, '-> ' + e.message);
}
if (!clean) { console.log('\ncould not transmute; aborting'); process.exit(1); }

const wasmBytes = clean.wasm || clean.bytes || clean.buffer;
check('transmute() produced bytes', !!wasmBytes, wasmBytes ? `${wasmBytes.length} bytes` : '');

const cleanFile = mkFile(wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes), 'clean.wasm');

// ---- 2. clean verifies ------------------------------------------------------
let vClean;
try { vClean = await verifyWasm(new Uint8Array(await cleanFile.arrayBuffer())); }
catch (e) { check('verifyWasm(clean) ran', false, '-> ' + e.message); }

if (vClean) {
  check('CLEAN payload verifies', vClean.valid === true, `valid=${vClean.valid}`);
  check('  baseline is real SHA-256', vClean.baselineIsSha256 === true);
  check('  baseline === recomputed', vClean.baselineMatchesActual === true,
    vClean.baseline ? `stored=${String(vClean.baseline).slice(0,16)}…` : '');
}

// ---- 3. tamper ONE byte inside fraymus.data and re-verify -------------------
// Find the base64 fraymus.data section and flip one character in the alphabet.
const raw = new Uint8Array(await cleanFile.arrayBuffer());
const text = new TextDecoder('latin1').decode(raw);
const idx = text.indexOf('fraymus.data');
check('found fraymus.data section', idx > 0, `offset ${idx}`);

let tampered = null, flipped = null;
if (idx > 0) {
  const after = text.slice(idx, idx + 4000);
  const m = after.match(/([A-Za-z0-9+/]{40,}={0,2})/);   // a base64 run
  if (m) {
    const at = idx + after.indexOf(m[1]) + 20;            // 20 chars into the payload
    const orig = raw[at];
    const swapped = orig === 0x41 ? 0x42 : 0x41;          // 'A' <-> 'B'
    tampered = Uint8Array.from(raw);
    tampered[at] = swapped;
    flipped = `${at}: 0x${orig.toString(16)} -> 0x${swapped.toString(16)} ('${String.fromCharCode(orig)}'->'${String.fromCharCode(swapped)}')`;
  }
}

let vTam = null;
if (tampered) {
  check('tampered 1 byte', true, flipped);
  try { vTam = await verifyWasm(tampered); }
  catch (e) { check('verifyWasm(tampered) ran', false, '-> ' + e.message); }

  if (vTam) {
    // THE assertion that matters
    check('TAMPERED payload is REJECTED', vTam.valid === false, `valid=${vTam.valid}`);
    check('  baseline !== recomputed', vTam.baselineMatchesActual === false);
    if (vTam.actualSha256 && vClean?.actualSha256) {
      check('  digest actually changed', vTam.actualSha256 !== vClean.actualSha256,
        `${String(vClean.actualSha256).slice(0,16)}… -> ${String(vTam.actualSha256).slice(0,16)}…`);
    }
    check('  no digest leakage: tampered digest != stored',
      vTam.actualSha256 !== vTam.baseline);
  }
}

// ---- 4. forge.js classic pipeline: 5 sections + base64 data ----------------
console.log('\n' + '='.repeat(78));
console.log('  CLASSIC PIPELINE: buildClassicWasm');
console.log('='.repeat(78));
try {
  const cw = await buildClassicWasm('engine', 'TestEngine', enc.encode('public class T {}'), { note: 'audit' });
  const cb = cw instanceof Uint8Array ? cw : new Uint8Array(cw);
  const ctext = new TextDecoder('latin1').decode(cb);
  const secs = ['fraymus.data', 'fraymus.baseline', 'fraymus.ledger', 'fraymus.catalog', 'fraymus.meta'];
  const present = secs.filter((s) => ctext.includes(s));
  check('emits all 5 sections', present.length === 5, `${present.length}/5: ${present.join(', ')}`);

  // data section must be base64 (atob-decodable), not raw bytes
  const di = ctext.indexOf('fraymus.data');
  const seg = ctext.slice(di, di + 2000);
  const bm = seg.match(/([A-Za-z0-9+/]{16,}={0,2})/);
  let isB64 = false;
  if (bm) { try { atob(bm[1]); isB64 = /^[A-Za-z0-9+/=]+$/.test(bm[1]); } catch {} }
  check('fraymus.data is base64 (atob-able)', isB64, bm ? `sample="${bm[1].slice(0,24)}…"` : 'no run found');
  check('catalog_id present (not a digest)',
    ctext.includes('catalog_id'), '');

  // now verify the classic wasm too
  const vc = await verifyWasm(cb);
  check('classic WASM verifies', vc?.valid === true, `valid=${vc?.valid}`);

  // and tamper it
  const t2 = Uint8Array.from(cb);
  const at2 = di + (bm ? seg.indexOf(bm[1]) + 10 : 30);
  const o2 = t2[at2];
  t2[at2] = o2 === 0x41 ? 0x42 : 0x41;
  const vt2 = await verifyWasm(t2);
  check('tampered CLASSIC WASM rejected', vt2?.valid === false, `valid=${vt2?.valid}`);
} catch (e) {
  check('buildClassicWasm ran', false, '-> ' + e.message);
}

console.log('\n' + '='.repeat(78));
console.log(`  ATTACK RESULT: ${pass} passed, ${fail} failed`);
console.log(fail === 0
  ? '  §6.4 hole CLOSED on the cloud copy — tampering is rejected.'
  : '  §6.4 hole still OPEN — see FAILs above.');
console.log('='.repeat(78) + '\n');
process.exit(fail === 0 ? 0 : 1);
