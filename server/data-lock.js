import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

/** Process-lifetime ownership, not a security boundary against the same user.
 * Windows pipes and Linux abstract sockets disappear on process exit. On other
 * Unix systems a crash may leave a socket pathname; never steal/unlink it here.
 */
export async function acquireDataLock(dataDir) {
  await mkdir(dataDir, {recursive: true});
  const canonical = await realpath(dataDir);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const token = createHash('sha256').update(identity).digest('hex');
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\chandra-data-${token}`
    : process.platform === 'linux' ? `\0chandra-data-${token}` : path.join('/tmp', `chandra-${token}.sock`);
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = cause => {
      server.removeListener('listening', owned);
      const error = new Error(cause.code === 'EADDRINUSE'
        ? 'Another Chandra process owns this data directory. Use the existing app or stop its owned worker before restarting.'
        : `Cannot obtain exclusive data-directory ownership (${cause.code || 'IPC error'}).`, {cause});
      error.code = cause.code === 'EADDRINUSE' ? 'data_directory_in_use' : 'data_lock_unavailable';
      reject(error);
    };
    const owned = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', owned);
    server.listen({path: address, exclusive: true, readableAll: false, writableAll: false});
  });
  // A lock must never disappear silently while its runtime keeps dispatching.
  server.on('error', error => { queueMicrotask(() => { throw error; }); });
  server.unref();
  let released;
  return Object.freeze({identity, address, release() {
    return released ??= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }});
}
