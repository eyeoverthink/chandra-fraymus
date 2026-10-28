import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createWindowsDesktopDriver } from './windows-driver.js';

export function configuredDesktopDriver({ dataDir }) {
  const filename = join(dataDir, 'desktop-config.json');
  if (!existsSync(filename)) return createWindowsDesktopDriver();
  try {
    if (statSync(filename).size > 65536) throw new Error();
    const config = JSON.parse(readFileSync(filename, 'utf8'));
    if (!config || Object.keys(config).some(key => !['schemaVersion','enabled','allowedExecutables','pythonPath'].includes(key))
      || config.schemaVersion !== 1 || typeof config.enabled !== 'boolean' || !Array.isArray(config.allowedExecutables)
      || config.allowedExecutables.length > 8 || config.allowedExecutables.some(value => typeof value !== 'string' || !isAbsolute(value))
      || config.pythonPath !== undefined && (typeof config.pythonPath !== 'string' || !isAbsolute(config.pythonPath))) throw new Error();
    return createWindowsDesktopDriver({ enabled: config.enabled, allowedExecutables: config.allowedExecutables,
      ...(config.pythonPath ? {pythonPath:config.pythonPath} : {}) });
  } catch {
    const disabled = createWindowsDesktopDriver();
    return { ...disabled, health: async () => ({configured:true,available:false,reason:'Invalid desktop operator configuration; repair it explicitly. No unrestricted driver fallback exists.'}) };
  }
}
