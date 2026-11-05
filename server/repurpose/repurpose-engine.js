import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';

export function initRepurposeTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repurpose_jobs (
      id TEXT PRIMARY KEY,
      source_content TEXT NOT NULL,
      source_format TEXT NOT NULL DEFAULT 'article',
      source_platform TEXT,
      target_formats TEXT DEFAULT '[]',
      target_platforms TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      variants TEXT DEFAULT '[]',
      variant_count INTEGER DEFAULT 0,
      quality_score REAL,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_repurpose_status ON repurpose_jobs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS repurpose_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_format TEXT NOT NULL,
      target_format TEXT NOT NULL,
      target_platform TEXT,
      prompt_template TEXT NOT NULL,
      tone TEXT DEFAULT 'match_source',
      max_length INTEGER,
      include_cta INTEGER DEFAULT 1,
      success_rate REAL DEFAULT 0,
      uses INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_template_formats ON repurpose_templates(source_format, target_format);
  `);

  const count = db.prepare('SELECT COUNT(*) as c FROM repurpose_templates').get()?.c || 0;
  if (count === 0) seedDefaultTemplates();
}

function seedDefaultTemplates() {
  const now = Date.now();
  const templates = [
    { name: 'Article to Twitter Thread', source: 'article', target: 'twitter_thread', platform: 'x',
      prompt: 'Convert this article into a Twitter/X thread of 5-8 tweets. First tweet is the hook. Use line breaks, no hashtags in thread body, hashtags only in last tweet. Each tweet under 280 chars.', maxLen: 2200 },
    { name: 'Article to Short Video Script', source: 'article', target: 'short_video_script', platform: 'tiktok',
      prompt: 'Convert this article into a 60-second short video script. Format: HOOK (first 3s), BODY (key points, visual cues in brackets), CTA. Conversational tone, direct address.', maxLen: 800 },
    { name: 'Article to LinkedIn Post', source: 'article', target: 'linkedin_post', platform: 'linkedin',
      prompt: 'Convert this article into a LinkedIn post. Start with a bold opening line, use short paragraphs, include a personal insight, end with a question. Professional but human tone.', maxLen: 3000 },
    { name: 'Article to Instagram Caption', source: 'article', target: 'instagram_caption', platform: 'instagram',
      prompt: 'Convert this article into an Instagram caption. Hook in first line (before "more"), storytelling middle, CTA at end, 5-8 relevant hashtags at bottom. Under 2200 chars.', maxLen: 2200 },
    { name: 'Article to YouTube Description', source: 'article', target: 'youtube_description', platform: 'youtube',
      prompt: 'Convert this article into a YouTube video description. First 2 lines are SEO-rich summary (shown before "Show more"). Include timestamps placeholder, key takeaways as bullet points, links section, tags.', maxLen: 5000 },
    { name: 'Article to Newsletter Blurb', source: 'article', target: 'newsletter_blurb', platform: 'email',
      prompt: 'Convert this article into a newsletter section. Punchy subject line suggestion, 2-3 paragraph blurb that teases the full content, clear CTA button text.', maxLen: 1500 },
    { name: 'Video Script to Blog Post', source: 'short_video_script', target: 'blog_post', platform: 'blog',
      prompt: 'Expand this video script into a full blog post. Add context, examples, and depth. Use H2 subheadings, include an intro and conclusion. SEO-friendly, 600-1000 words.', maxLen: 6000 },
    { name: 'Article to Carousel Slides', source: 'article', target: 'carousel_slides', platform: 'instagram',
      prompt: 'Convert this article into 8-10 carousel slide texts. First slide: bold hook. Middle slides: one key point each (short, punchy). Last slide: CTA + save prompt. Each slide under 100 words.', maxLen: 3000 },
  ];

  const stmt = db.prepare(`INSERT INTO repurpose_templates (id, name, source_format, target_format, target_platform, prompt_template, max_length, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of templates) {
    stmt.run(`tpl_${Math.random().toString(36).slice(2, 10)}`, t.name, t.source, t.target, t.platform, t.prompt, t.maxLen, now);
  }
}

export function getTemplates({ sourceFormat, targetFormat } = {}) {
  let sql = 'SELECT * FROM repurpose_templates WHERE 1=1';
  const params = [];
  if (sourceFormat) { sql += ' AND source_format = ?'; params.push(sourceFormat); }
  if (targetFormat) { sql += ' AND target_format = ?'; params.push(targetFormat); }
  sql += ' ORDER BY uses DESC, success_rate DESC';
  return db.prepare(sql).all(...params);
}

export function getJobs({ status, limit } = {}) {
  let sql = 'SELECT * FROM repurpose_jobs WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Math.min(100, parseInt(limit) || 20)); }
  return db.prepare(sql).all(...params);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM repurpose_jobs WHERE id = ?').get(id);
}

export function getRepurposeStats() {
  const totalJobs = db.prepare('SELECT COUNT(*) as c FROM repurpose_jobs').get()?.c || 0;
  const completed = db.prepare("SELECT COUNT(*) as c FROM repurpose_jobs WHERE status = 'completed'").get()?.c || 0;
  const totalVariants = db.prepare('SELECT SUM(variant_count) as c FROM repurpose_jobs').get()?.c || 0;
  const avgQuality = db.prepare("SELECT AVG(quality_score) as avg FROM repurpose_jobs WHERE quality_score IS NOT NULL AND status = 'completed'").get()?.avg;
  const avgDuration = db.prepare("SELECT AVG(duration_ms) as avg FROM repurpose_jobs WHERE status = 'completed'").get()?.avg;
  const topTemplates = db.prepare('SELECT name, target_format, target_platform, uses, success_rate FROM repurpose_templates ORDER BY uses DESC LIMIT 5').all();
  const byFormat = db.prepare("SELECT source_format, COUNT(*) as jobs, SUM(variant_count) as variants FROM repurpose_jobs GROUP BY source_format ORDER BY jobs DESC").all();
  return { totalJobs, completed, totalVariants, avgQuality, avgDuration, topTemplates, byFormat };
}

export async function repurposeContent({ content, sourceFormat, sourcePlatform, targetFormats, targetPlatforms, audienceSegment, memoryBridge, broadcast }) {
  const startTime = Date.now();
  const jobId = `rp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const formats = targetFormats || ['twitter_thread', 'short_video_script', 'linkedin_post', 'instagram_caption'];
  const platforms = targetPlatforms || ['x', 'tiktok', 'linkedin', 'instagram'];

  db.prepare(`INSERT INTO repurpose_jobs (id, source_content, source_format, source_platform, target_formats, target_platforms, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(
    jobId, content.slice(0, 10000), sourceFormat || 'article', sourcePlatform || null,
    JSON.stringify(formats), JSON.stringify(platforms), startTime
  );

  if (broadcast) broadcast('repurpose', { type: 'job_started', id: jobId });

  const templates = getTemplates({ sourceFormat: sourceFormat || 'article' });
  const variants = [];

  for (const fmt of formats) {
    const template = templates.find(t => t.target_format === fmt);
    const platform = platforms[formats.indexOf(fmt)] || 'general';

    const promptInstruction = template
      ? template.prompt_template
      : `Convert this ${sourceFormat || 'article'} into a ${fmt.replace(/_/g, ' ')} for ${platform}. Match the tone and optimize for the platform's format and audience expectations.`;

    let audienceContext = '';
    if (audienceSegment) {
      audienceContext = `\nTarget audience: ${audienceSegment}. Tailor the tone, vocabulary, and angle for this audience.`;
    }

    const system = `You are a content repurposing specialist. ${promptInstruction}${audienceContext}

Return JSON: {
  "title": "variant title/headline",
  "content": "the repurposed content",
  "platform": "${platform}",
  "format": "${fmt}",
  "word_count": number,
  "hashtags": ["if applicable"],
  "cta": "call to action text",
  "notes": "any platform-specific notes"
}`;

    try {
      const raw = await chatOllama([
        { role: 'system', content: system },
        { role: 'user', content: `Source content (${sourceFormat || 'article'}):\n\n${content.slice(0, 5000)}` },
      ]);

      const parsed = parseJSON(raw);
      if (parsed) {
        variants.push({ ...parsed, format: fmt, platform, templateUsed: template?.id || null });
        if (template) {
          db.prepare('UPDATE repurpose_templates SET uses = uses + 1 WHERE id = ?').run(template.id);
        }
      }
    } catch (e) {
      variants.push({ format: fmt, platform, error: e.message });
    }
  }

  const qualityScores = variants.filter(v => !v.error).map(v => {
    let score = 0.5;
    if (v.content && v.content.length > 50) score += 0.2;
    if (v.cta) score += 0.1;
    if (v.hashtags?.length > 0) score += 0.05;
    if (v.title) score += 0.1;
    return Math.min(1, score);
  });
  const avgQuality = qualityScores.length > 0 ? qualityScores.reduce((s, v) => s + v, 0) / qualityScores.length : 0;

  const successCount = variants.filter(v => !v.error).length;
  const jobStatus = successCount === 0 ? 'failed' : successCount < variants.length ? 'partial_failure' : 'completed';
  db.prepare(`UPDATE repurpose_jobs SET status = ?, variants = ?, variant_count = ?, quality_score = ?, duration_ms = ?, completed_at = ? WHERE id = ?`)
    .run(jobStatus, JSON.stringify(variants), successCount, avgQuality, Date.now() - startTime, Date.now(), jobId);

  if (broadcast) broadcast('repurpose', { type: 'job_completed', id: jobId, status: jobStatus, variants: variants.length, successCount });

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'content_repurpose',
      feeling: { primary: 'satisfaction', intensity: 0.6 },
      response: `Repurposed into ${variants.filter(v => !v.error).length} variants (quality ${(avgQuality * 100).toFixed(0)}%)`,
      durationMs: Date.now() - startTime,
    }).catch(() => {});
  }

  return { jobId, variants, quality: avgQuality, duration: Date.now() - startTime };
}

export async function suggestRepurposeTargets(content, { memoryBridge } = {}) {
  let topPerforming = [];
  try {
    topPerforming = db.prepare(`SELECT target_format, target_platform, AVG(success_rate) as avg_success, SUM(uses) as total_uses
      FROM repurpose_templates WHERE uses > 0
      GROUP BY target_format, target_platform ORDER BY avg_success DESC LIMIT 10`).all();
  } catch {}

  let audiencePrefs = [];
  try {
    audiencePrefs = db.prepare(`SELECT preferred_formats, preferred_platforms FROM audience_segments WHERE status = 'active' ORDER BY engagement_avg DESC LIMIT 5`).all();
  } catch {}

  const system = `You are a content strategy advisor. Given source content, recommend the best repurposing targets.

Return JSON: {
  "recommendations": [
    { "format": "twitter_thread|short_video_script|linkedin_post|instagram_caption|carousel_slides|newsletter_blurb|blog_post|youtube_description",
      "platform": "x|tiktok|linkedin|instagram|youtube|email|blog",
      "priority": "high|medium|low",
      "reasoning": "why this format works for this content",
      "estimated_reach_multiplier": 1.0-5.0 }
  ],
  "content_type": "detected type of source content",
  "key_angles": ["angle1", "angle2"]
}`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Source content (first 2000 chars):\n\n${content.slice(0, 2000)}\n\nHistorical template performance:\n${JSON.stringify(topPerforming)}\n\nAudience format preferences:\n${JSON.stringify(audiencePrefs.map(a => ({ formats: a.preferred_formats, platforms: a.preferred_platforms })))}` },
  ]);

  const parsed = parseJSON(raw);
  return { suggestions: parsed, contentLength: content.length };
}
