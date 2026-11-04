// Singleton CTRNN instance shared across subsystems.
// Both fraymus-routes (REST API) and consciousness-cycle (daemon audit)
// import from here so they operate on the same live neural core.
import { createCTRNN } from './ctrnn.js';

let _instance = null;

export function getCTRNN() {
  if (!_instance) {
    _instance = createCTRNN();
  }
  return _instance;
}
