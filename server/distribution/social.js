import { PLATFORMS, platformAvailable, chatOllama, parseJSON } from './shared.js';

export async function optimizeForPlatform(content, platformId) {
  const cfg = PLATFORMS[platformId];
  if (!cfg) throw new Error(`Unknown platform: ${platformId}`);

  const system = `You are a social media optimization expert. Adapt content for ${cfg.name}.
Rules:
- Title max ${cfg.maxTitle} chars (0 = no title field)
- Description max ${cfg.maxDesc} chars
- Tags max ${cfg.maxTags} (0 = no tags, use hashtags in description)
- Platform voice: ${platformId === 'youtube' ? 'searchable, keyword-rich, hook in first line' :
    platformId === 'tiktok' ? 'casual, trend-aware, hook in 3 seconds, hashtag heavy' :
    platformId === 'instagram' ? 'visual-first, story-driven, hashtag clusters' :
    platformId === 'x' ? 'punchy, provocative, thread-aware, under 280 chars' :
    'professional, SEO-optimized'}
Return JSON: { "title": "...", "description": "...", "tags": [...], "hashtags": [...], "hook": "first 5 seconds script", "cta": "call to action", "bestPostTime": "HH:MM UTC" }`;

  const raw = await chatOllama(system, JSON.stringify(content));
  const optimized = parseJSON(raw);
  if (!optimized) return { title: content.topic?.slice(0, cfg.maxTitle) || '', description: content.topic || '', tags: [], hashtags: [], hook: '', cta: '', bestPostTime: '14:00' };
  return optimized;
}

export async function publishToYouTube(pkg) {
  const key = process.env.YOUTUBE_API_KEY;
  const token = process.env.YOUTUBE_OAUTH_TOKEN;
  if (!key && !token) return { status: 'skipped', reason: 'no YouTube credentials', platform: 'youtube' };

  return {
    status: 'queued',
    platform: 'youtube',
    title: pkg.title,
    description: pkg.description?.slice(0, 5000),
    tags: pkg.tags?.slice(0, 15),
    scheduledFor: pkg.scheduledFor || null,
    note: 'YouTube Data API v3 upload requires OAuth2 token with youtube.upload scope — set YOUTUBE_OAUTH_TOKEN',
  };
}

export async function publishToTikTok(pkg) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) return { status: 'skipped', reason: 'no TikTok credentials', platform: 'tiktok' };

  return {
    status: 'queued',
    platform: 'tiktok',
    title: pkg.title?.slice(0, 150),
    description: `${pkg.description || ''}\n${(pkg.hashtags || []).map(h => `#${h}`).join(' ')}`.slice(0, 2200),
    scheduledFor: pkg.scheduledFor || null,
    note: 'TikTok Content Posting API requires approved app with video.publish scope',
  };
}

export async function publishToInstagram(pkg) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return { status: 'skipped', reason: 'no Instagram credentials', platform: 'instagram' };

  return {
    status: 'queued',
    platform: 'instagram',
    caption: `${pkg.description || ''}\n\n${(pkg.hashtags || []).slice(0, 30).map(h => `#${h}`).join(' ')}`.slice(0, 2200),
    scheduledFor: pkg.scheduledFor || null,
    note: 'Instagram Graph API requires Facebook Page with linked Instagram Business account',
  };
}

export async function publishToX(pkg) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { status: 'skipped', reason: 'no X credentials', platform: 'x' };

  return {
    status: 'queued',
    platform: 'x',
    text: pkg.description?.slice(0, 280) || pkg.title?.slice(0, 280) || '',
    scheduledFor: pkg.scheduledFor || null,
    note: 'X API v2 requires OAuth 2.0 with tweet.write scope',
  };
}

const PUBLISHERS = {
  youtube: publishToYouTube,
  tiktok: publishToTikTok,
  instagram: publishToInstagram,
  x: publishToX,
};

export async function distributeToAll(content, platforms = null) {
  const targets = platforms || Object.keys(PLATFORMS).filter(platformAvailable);
  const results = [];

  for (const platformId of targets) {
    try {
      const optimized = await optimizeForPlatform(content, platformId);
      const publisher = PUBLISHERS[platformId];
      if (!publisher) {
        results.push({ platform: platformId, status: 'skipped', reason: 'no publisher' });
        continue;
      }
      const result = await publisher({ ...content, ...optimized });
      results.push(result);
    } catch (e) {
      results.push({ platform: platformId, status: 'error', error: e.message });
    }
  }

  return results;
}
