// Singleton CTRNN instance shared across subsystems.
// Both fraymus-routes (REST API) and consciousness-cycle (daemon audit)
// import from here so they operate on the same live neural core.
import { join } from 'node:path';
import { createCTRNN } from './ctrnn.js';
import { DATA_DIR } from '../config.js';

export const CTRNN_STATE_PATH = join(DATA_DIR, 'ctrnn-state.json');

let _instance = null;

export function getCTRNN() {
  if (!_instance) {
    _instance = createCTRNN();
    _instance.setPersistPath(CTRNN_STATE_PATH);
    const r = _instance.restoreFromFile(CTRNN_STATE_PATH);
    if (r.restored) {
      console.log(`[ctrnn] resumed from tick ${r.tick} (${r.activeSynapses ?? '?'} synapses, saved ${new Date(r.ts).toISOString()})`);
    } else if (r.reason !== 'no_state_file') {
      console.warn(`[ctrnn] state file ignored: ${r.reason}`);
    }
  }
  return _instance;
}

export function persistCTRNN() {
  return _instance ? _instance.persist() : { persisted: false, error: 'not_created' };
}
