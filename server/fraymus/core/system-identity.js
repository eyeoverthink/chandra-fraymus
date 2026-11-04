// Persistent local signing identity. Never replace an unreadable existing key.
// Fraynix - By Vaughn Scott
import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../config.js';
import { generateIdentity, signText, verifyText } from './identity.js';

const identityFile = join(DATA_DIR, 'fraymus-identity.json');
let pending;

async function validate(identity) {
  if (!identity || !/^[a-f0-9]{64}$/i.test(identity.pubkey || '') || !identity.priv) {
    throw new Error('Stored FRAYMUS identity has invalid key fields');
  }
  const challenge = 'FRAYMUS local identity consistency check';
  const signature = await signText(identity, challenge);
  if (!await verifyText(identity.pubkey, challenge, signature)) {
    throw new Error('Stored FRAYMUS signing/public keys do not match');
  }
  return identity;
}

async function loadOrCreate() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(identityFile)) return validate(JSON.parse(readFileSync(identityFile, 'utf8')));
  const identity = await generateIdentity('CHANDRA-FRAYMUS');
  let descriptor;
  try {
    descriptor = openSync(identityFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return validate(JSON.parse(readFileSync(identityFile, 'utf8')));
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify(identity) + '\n');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  return validate(identity);
}

export function getSystemIdentity() {
  if (!pending) {
    pending = loadOrCreate().catch(error => {
      pending = undefined;
      throw new Error(`FRAYMUS identity unavailable; existing key preserved: ${error.message}`);
    });
  }
  return pending;
}
