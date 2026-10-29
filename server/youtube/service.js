import { db, logEvent } from '../db.js';

const YT_API = 'https://www.googleapis.com/youtube/v3';
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const TIMEOUT = 12_000;

function apiKey() {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY not set — add it to .env');
  return API_KEY;
}

async function ytFetch(path, params) {
  const qs = new URLSearchParams({ ...params, key: apiKey() });
  const res = await fetch(`${YT_API}/${path}?${qs}`, {
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function searchVideos(query, { maxResults = 20, order = 'relevance', lang = 'en' } = {}) {
  const data = await ytFetch('search', {
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: Math.min(maxResults, 50),
    order,
    relevanceLanguage: lang,
  });
  return (data.items || []).map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    publishedAt: item.snippet.publishedAt,
  }));
}

export async function getVideoStats(videoIds) {
  if (!videoIds.length) return {};
  const batches = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    batches.push(videoIds.slice(i, i + 50));
  }
  const stats = {};
  for (const batch of batches) {
    const data = await ytFetch('videos', {
      part: 'statistics,contentDetails',
      id: batch.join(','),
    });
    for (const item of data.items || []) {
      const dur = item.contentDetails?.duration || '';
      stats[item.id] = {
        viewCount: Number(item.statistics.viewCount || 0),
        likeCount: Number(item.statistics.likeCount || 0),
        commentCount: Number(item.statistics.commentCount || 0),
        duration: parseDuration(dur),
        durationRaw: dur,
      };
    }
  }
  return stats;
}

export async function getChannelStats(channelIds) {
  if (!channelIds.length) return {};
  const unique = [...new Set(channelIds)];
  const batches = [];
  for (let i = 0; i < unique.length; i += 50) {
    batches.push(unique.slice(i, i + 50));
  }
  const stats = {};
  for (const batch of batches) {
    const data = await ytFetch('channels', {
      part: 'statistics',
      id: batch.join(','),
    });
    for (const item of data.items || []) {
      stats[item.id] = {
        subscriberCount: Number(item.statistics.subscriberCount || 0),
        videoCount: Number(item.statistics.videoCount || 0),
      };
    }
  }
  return stats;
}

export async function analyzeUrl(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract video ID from URL');

  const [videoData] = await Promise.all([
    ytFetch('videos', { part: 'snippet,statistics,contentDetails', id: videoId }),
  ]);

  const item = videoData.items?.[0];
  if (!item) throw new Error('Video not found');

  const channelStats = await getChannelStats([item.snippet.channelId]);
  const subs = channelStats[item.snippet.channelId]?.subscriberCount || 0;
  const views = Number(item.statistics.viewCount || 0);

  return {
    videoId,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || '',
    publishedAt: item.snippet.publishedAt,
    viewCount: views,
    likeCount: Number(item.statistics.likeCount || 0),
    commentCount: Number(item.statistics.commentCount || 0),
    duration: parseDuration(item.contentDetails?.duration || ''),
    durationRaw: item.contentDetails?.duration || '',
    subscriberCount: subs,
    ...classifyOutlier(views, subs),
  };
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    return u.searchParams.get('v') || '';
  } catch {
    const m = /(?:v=|\/)([\w-]{11})/.exec(url);
    return m ? m[1] : '';
  }
}

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export function classifyOutlier(views, subscribers) {
  if (!subscribers || subscribers === 0) {
    return { outlierRatio: null, outlierTier: 'unknown' };
  }
  const ratio = views / subscribers;
  let tier;
  if (ratio >= 10)      tier = 'big';
  else if (ratio >= 3)  tier = 'mid';
  else                  tier = 'none';
  return { outlierRatio: Math.round(ratio * 100) / 100, outlierTier: tier };
}

export async function searchAndAnalyze(query, opts = {}) {
  const videos = await searchVideos(query, opts);
  if (!videos.length) return [];

  const videoIds = videos.map(v => v.videoId);
  const channelIds = videos.map(v => v.channelId);

  const [videoStats, channelStats] = await Promise.all([
    getVideoStats(videoIds),
    getChannelStats(channelIds),
  ]);

  return videos.map(v => {
    const vs = videoStats[v.videoId] || {};
    const cs = channelStats[v.channelId] || {};
    return {
      ...v,
      viewCount: vs.viewCount || 0,
      likeCount: vs.likeCount || 0,
      commentCount: vs.commentCount || 0,
      duration: vs.duration || 0,
      durationRaw: vs.durationRaw || '',
      subscriberCount: cs.subscriberCount || 0,
      ...classifyOutlier(vs.viewCount || 0, cs.subscriberCount || 0),
    };
  });
}

// ---------- Board persistence ----------

db.exec(`
CREATE TABLE IF NOT EXISTS outlier_board (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
  video_id TEXT NOT NULL,
  title TEXT,
  channel_title TEXT,
  channel_id TEXT,
  thumbnail TEXT,
  published_at TEXT,
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  subscriber_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  outlier_ratio REAL,
  outlier_tier TEXT,
  notes TEXT DEFAULT '',
  search_query TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outlier_board_user ON outlier_board(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outlier_board_vid ON outlier_board(user_id, video_id);
`);

export function saveToBoard(userId, video, notes = '', searchQuery = '') {
  const now = Date.now();
  const info = db.prepare(`INSERT OR REPLACE INTO outlier_board
    (user_id, video_id, title, channel_title, channel_id, thumbnail, published_at,
     view_count, like_count, subscriber_count, duration, outlier_ratio, outlier_tier,
     notes, search_query, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, video.videoId, video.title, video.channelTitle, video.channelId,
    video.thumbnail, video.publishedAt,
    video.viewCount || 0, video.likeCount || 0, video.subscriberCount || 0,
    video.duration || 0, video.outlierRatio, video.outlierTier,
    notes, searchQuery, now,
  );
  logEvent('outlier.save', userId, `${video.title?.slice(0, 60)} (${video.outlierTier})`);
  return { id: info.lastInsertRowid, saved: true };
}

export function getBoard(userId, { tier, search, sort = 'recent', limit = 100 } = {}) {
  let sql = 'SELECT * FROM outlier_board WHERE user_id = ?';
  const params = [userId];

  if (tier && tier !== 'all') {
    sql += ' AND outlier_tier = ?';
    params.push(tier);
  }
  if (search) {
    sql += ' AND (title LIKE ? OR channel_title LIKE ? OR notes LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  if (sort === 'duration') sql += ' ORDER BY duration DESC';
  else if (sort === 'views') sql += ' ORDER BY view_count DESC';
  else if (sort === 'outlier') sql += ' ORDER BY outlier_ratio DESC';
  else sql += ' ORDER BY created_at DESC';

  sql += ' LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function updateBoardNotes(userId, id, notes) {
  db.prepare('UPDATE outlier_board SET notes = ? WHERE id = ? AND user_id = ?')
    .run(notes, id, userId);
  return { updated: true };
}

export function removeFromBoard(userId, id) {
  db.prepare('DELETE FROM outlier_board WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return { removed: true };
}

export function boardStats(userId) {
  const total = db.prepare('SELECT COUNT(*) as n FROM outlier_board WHERE user_id = ?').get(userId)?.n || 0;
  const byTier = db.prepare('SELECT outlier_tier, COUNT(*) as n FROM outlier_board WHERE user_id = ? GROUP BY outlier_tier').all(userId);
  return { total, byTier: Object.fromEntries(byTier.map(r => [r.outlier_tier, r.n])) };
}
