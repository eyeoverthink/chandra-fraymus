import {
  searchAndAnalyze, analyzeUrl, classifyOutlier,
  saveToBoard, getBoard, updateBoardNotes, removeFromBoard, boardStats,
} from './service.js';

export function installYouTubeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/youtube/search', route(async (req, res) => {
    const { query, maxResults = 20, order = 'relevance', lang = 'en' } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const results = await searchAndAnalyze(query, { maxResults, order, lang });
    res.json({ results, query });
  }));

  app.post('/api/youtube/analyze-url', route(async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const video = await analyzeUrl(url);
    res.json(video);
  }));

  app.post('/api/youtube/board', route(async (req, res) => {
    const { video, notes = '', searchQuery = '' } = req.body;
    if (!video?.videoId) return res.status(400).json({ error: 'video with videoId required' });
    const result = saveToBoard(req.body.userId || 'local', video, notes, searchQuery);
    res.status(201).json(result);
  }));

  app.get('/api/youtube/board', route((req, res) => {
    const { tier, search, sort, limit } = req.query;
    const items = getBoard(req.query.userId || 'local', { tier, search, sort, limit: Number(limit) || 100 });
    res.json({ items });
  }));

  app.put('/api/youtube/board/:id', route((req, res) => {
    const result = updateBoardNotes(req.body.userId || 'local', Number(req.params.id), req.body.notes || '');
    res.json(result);
  }));

  app.delete('/api/youtube/board/:id', route((req, res) => {
    const result = removeFromBoard(req.query.userId || 'local', Number(req.params.id));
    res.json(result);
  }));

  app.get('/api/youtube/board/stats', route((req, res) => {
    res.json(boardStats(req.query.userId || 'local'));
  }));
}
