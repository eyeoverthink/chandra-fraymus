// WASM container — lightweight (single section) + full 5-section transmuter
import { WASM_MAGIC, PHI, PHI_SEAL } from '../core/constants.js';
import { sha256hex, concat, bytesToBase64, base64ToBytes } from '../core/crypto.js';
import { dnaHypervector } from './dna.js';

function u8(arr) { return new Uint8Array(arr); }

function leb128(v) {
  const out = [];
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function section(id, body) {
  return concat([u8([id]), u8(leb128(body.length)), body]);
}

function encodeString(s) {
  const b = new TextEncoder().encode(s);
  return concat([u8(leb128(b.length)), b]);
}

// ═══ Lightweight WASM wrap (single fraymus.data section) ═══

export function wrapWasm(payload) {
  const name = new TextEncoder().encode('fraymus.data');
  const nameLen = leb128(name.length);
  const bodyLen = nameLen.length + name.length + payload.length;
  const bodyLenEnc = leb128(bodyLen);
  const out = new Uint8Array(8 + 1 + bodyLenEnc.length + bodyLen);
  out.set([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0], 0);
  let o = 8;
  out[o++] = 0;
  out.set(bodyLenEnc, o); o += bodyLenEnc.length;
  out.set(nameLen, o); o += nameLen.length;
  out.set(name, o); o += name.length;
  out.set(payload, o);
  return out;
}

// ═══ Full 5-section WASM transmuter ═══

function copyrightHash(sha) {
  const bytes = sha.match(/.{2}/g).map((h) => parseInt(h, 16));
  const folded = bytes.reduce((a, b, i) => a ^ (b * (1 + (i % 7))), 0);
  const phiKey = Math.round((PHI * 1e9) % 0xffffff);
  return '0x' + (folded ^ phiKey).toString(16).padStart(8, '0').toUpperCase();
}

export async function genesisBlock0(shaHex, fileName, timestamp) {
  const blockHashHex = await sha256hex(new TextEncoder().encode(`${shaHex}|${timestamp}|${PHI}`));
  return {
    block: 0,
    hash: blockHashHex,
    payload: {
      identity: fileName,
      cortex_signature: shaHex,
      initial_beliefs: ['persistence', 'reversibility', 'phi-harmony'],
    },
    parent: null,
    depth: 0,
    timestamp,
    phi_seal: '0x' + PHI_SEAL.toString(16).toUpperCase(),
  };
}

export function buildWasm(ledger, originalBytes, baselineHex, dnaBytes, genesisJson) {
  const magic = u8([0x00, 0x61, 0x73, 0x6d]);
  const version = u8([0x01, 0x00, 0x00, 0x00]);
  const typeBody = u8([0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]);
  const funcBody = u8([0x01, 0x00]);
  const exportBody = concat([u8([0x01]), encodeString('execute'), u8([0x00, 0x00])]);
  const code = u8([0x00, 0x20, 0x00, 0x0b]);
  const codeBody = concat([u8([0x01]), u8(leb128(code.length)), code]);

  const baselineBody = concat([encodeString('fraymus.baseline'), new TextEncoder().encode(baselineHex)]);
  const dnaBody = concat([encodeString('fraymus.dna'), dnaBytes]);
  const genesisBody = concat([encodeString('fraymus.genesis'), new TextEncoder().encode(JSON.stringify(genesisJson))]);
  const ledgerBody = concat([encodeString('fraymus.ledger'), new TextEncoder().encode(JSON.stringify(ledger))]);
  const dataB64 = new TextEncoder().encode(bytesToBase64(originalBytes));
  const dataBody = concat([encodeString('fraymus.data'), dataB64]);

  return concat([
    magic, version,
    section(0x01, typeBody), section(0x03, funcBody),
    section(0x07, exportBody), section(0x0a, codeBody),
    section(0x00, baselineBody), section(0x00, dnaBody),
    section(0x00, genesisBody), section(0x00, ledgerBody),
    section(0x00, dataBody),
  ]);
}

export async function decodeWasm(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x00 || u[1] !== 0x61 || u[2] !== 0x73 || u[3] !== 0x6d) {
    throw new Error('Not a WASM binary');
  }
  let i = 8;
  const sections = {};
  while (i < u.length) {
    const secId = u[i++];
    let len = 0, shift = 0;
    while (i < u.length) {
      const b = u[i++]; len |= (b & 0x7f) << shift; shift += 7;
      if (!(b & 0x80)) break;
    }
    const secEnd = i + len;
    if (secId === 0x00) {
      let nameLen = 0, ns = 0, ni = i;
      while (ni < u.length) {
        const b = u[ni++]; nameLen |= (b & 0x7f) << ns; ns += 7;
        if (!(b & 0x80)) break;
      }
      const name = new TextDecoder().decode(u.subarray(ni, ni + nameLen));
      const payload = u.subarray(ni + nameLen, secEnd);
      if (name.startsWith('fraymus.')) {
        sections[name] = { bytes: payload, text: new TextDecoder().decode(payload) };
      }
    }
    i = secEnd;
  }

  const dataB64 = sections['fraymus.data']?.text ?? null;
  let ledger = null;
  if (sections['fraymus.ledger']) {
    try { ledger = JSON.parse(sections['fraymus.ledger'].text); } catch { ledger = null; }
  }
  const baseline = sections['fraymus.baseline']?.text || null;
  const dna = sections['fraymus.dna']?.bytes || null;
  let genesis = null;
  if (sections['fraymus.genesis']) {
    try { genesis = JSON.parse(sections['fraymus.genesis'].text); } catch { genesis = null; }
  }

  if (!ledger) throw new Error('No fraymus.* DNA marker found');
  const original = dataB64 !== null ? base64ToBytes(dataB64) : null;

  return { ledger, original, baseline, dna, genesis, sectionNames: Object.keys(sections) };
}

export async function verifyWasm(buf) {
  const u = new Uint8Array(buf);
  const magicOk = u[0] === 0x00 && u[1] === 0x61 && u[2] === 0x73 && u[3] === 0x6d;
  const expected = ['fraymus.baseline', 'fraymus.dna', 'fraymus.genesis', 'fraymus.ledger', 'fraymus.data'];
  let parsed;
  try { parsed = await decodeWasm(buf); }
  catch (e) { return { magicOk, valid: false, error: e.message, sections: [], expected }; }

  const present = parsed.sectionNames || [];
  const allPresent = expected.every((n) => present.includes(n));
  let actualSha256 = null;
  if (parsed.original) {
    try { actualSha256 = await sha256hex(parsed.original); } catch { actualSha256 = null; }
  }
  const baselineMatchesActual = !!actualSha256 && actualSha256 === parsed.baseline;
  const sizeMatch = !!parsed.original && typeof parsed.ledger?.size === 'number' && parsed.original.length === parsed.ledger.size;

  return {
    magicOk,
    valid: magicOk && allPresent && baselineMatchesActual && sizeMatch,
    baseline: parsed.baseline,
    actualSha256,
    baselineMatchesActual,
    sizeMatch,
    dnaSize: parsed.dna?.length || 0,
    genesis: parsed.genesis,
    ledger: parsed.ledger,
    expected,
  };
}

export async function transmute(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256hex(bytes);
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const timestamp = new Date().toISOString();
  const ledger = {
    original: file.name,
    file_type: ext,
    size: bytes.length,
    sha256: sha,
    copyright_hash: copyrightHash(sha),
    timestamp,
    agent: 'Fraymus/MasterSystem',
    reversible: true,
    data_section: 'fraymus.data',
    sections: ['fraymus.baseline', 'fraymus.dna', 'fraymus.genesis', 'fraymus.ledger', 'fraymus.data'],
    lineage: ['HASH', 'LEDGER', 'BUILD'],
  };
  const dna = dnaHypervector(bytes, sha);
  const genesis = await genesisBlock0(sha, file.name, timestamp);
  const wasm = buildWasm(ledger, bytes, sha, dna, genesis);
  return { wasm, ledger, sha256: sha, size: wasm.length, dna, genesis };
}

export async function decodeWasmFile(file) {
  const buf = await file.arrayBuffer();
  const r = await decodeWasm(buf);
  const sha = r.original ? await sha256hex(r.original) : null;
  return { ...r, sha256: sha };
}
