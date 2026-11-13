import { ensureSchema } from './schema.js';
import { createTelemetry } from './telemetry.js';
import { createRegistry } from './registry.js';
import { createGraphService } from './graph-service.js';
import { createBrainService } from './brain-service.js';
import { createVoiceService } from './voice-service.js';
import { createRecipes } from './recipes.js';
import { createCommandService } from './command-service.js';

import { installFraymusOsRoutes as mountFraymusOsRoutes } from './routes.js';

export function installFraymusOsRoutes(app, options = {}) {
  const os = options.os || createFraymusOs(options);
  return mountFraymusOsRoutes(app, { ...options, os });
}
export { SUGGESTED_PROMPTS } from './command-service.js';
export { PRESETS } from './recipes.js';
export { classifyHost, classifyUrl, selectInstalledModel } from './registry.js';

export function createFraymusOs(options = {}) {
  if (!options.db) throw new Error('fraymus-os requires a database');
  ensureSchema(options.db);
  const telemetry = options.telemetry || createTelemetry(options.db);
  const registry = createRegistry({ ...options, telemetry });
  const graph = createGraphService(options.db, options);
  const voice = createVoiceService({ ...options, telemetry });
  const recipes = createRecipes({ ...options, db: options.db });
  const command = createCommandService({
    db: options.db, registry, graph, recipes, voice, broadcast: options.broadcast, fleet: options.fleet || null,
  });
  const brain = createBrainService(options.db);
  return { db: options.db, telemetry, registry, graph, brain, voice, recipes, command };
}
