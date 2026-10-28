import { DATA_DIR } from './config.js';
import { acquireDataLock } from './data-lock.js';

// Importing app.js opens/migrates SQLite and recovers interrupted runs. Acquire
// directory ownership first, even when a second instance selects another PORT.
// Keep the OS handle until process exit, including shutdown callback drain.
try {
  await acquireDataLock(DATA_DIR);
  await import('./app.js');
} catch (error) {
  console.error(`Local runtime did not start: ${error.code || 'startup_error'}: ${error.message}`);
  process.exitCode = 1;
}
