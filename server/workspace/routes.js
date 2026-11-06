import { join } from 'node:path';
import { generateWorkspaceDocs, collectSystemSnapshot } from './doc-generator.js';

const DATA_DIR = process.env.CHANDRA_DATA_DIR || './data';
const DEFAULT_OUTPUT = join(DATA_DIR, 'workspace');

export function installWorkspaceRoutes(app, { broadcast }) {
  app.post('/api/workspace/generate', async (req, res, next) => {
    try {
      const outputDir = req.body?.outputDir || DEFAULT_OUTPUT;
      const result = generateWorkspaceDocs(outputDir);
      broadcast('event', { source: 'workspace', action: 'generated', files: result.filesGenerated });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/workspace/snapshot', (req, res, next) => {
    try {
      const snap = collectSystemSnapshot();
      res.json(snap);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/workspace/status', (req, res) => {
    res.json({
      available: true,
      defaultOutputDir: DEFAULT_OUTPUT,
      endpoints: [
        'POST /api/workspace/generate — generate sequenced READMEs + snapshot',
        'GET  /api/workspace/snapshot — live system state JSON',
        'GET  /api/workspace/status   — this status check',
      ],
    });
  });
}
