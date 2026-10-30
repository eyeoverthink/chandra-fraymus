import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama } from './shared.js';

const now = () => Date.now();

// ── Stage 1: Researcher ─────────────────────────────────────────────
export async function runResearcher(input, opts = {}) {
  const { topic, contentType = 'both', sources = 'both' } = input;
  if (!topic) throw new Error('topic required');

  const steps = [];
  let webResults = '';
  let outlierResults = '';

  if (sources === 'web' || sources === 'both') {
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic + ' trends 2026')}`, {
        headers: { 'User-Agent': 'ChandraAgent/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
      const html = await r.text();
      const out = [];
      const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 8) {
        const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        out.push(`- ${strip(m[2])}: ${strip(m[3])}`);
      }
      webResults = out.join('\n');
      steps.push({ stage: 'web_search', status: 'ok', count: out.length });
    } catch (e) {
      steps.push({ stage: 'web_search', status: 'error', error: e.message });
    }
  }

  if (sources === 'youtube' || sources === 'both') {
    try {
      const rows = db.prepare(
        `SELECT title, channel_title, view_count, subscriber_count, outlier_ratio, outlier_tier
         FROM outlier_board WHERE outlier_tier IN ('big','mid')
         ORDER BY outlier_ratio DESC LIMIT 10`
      ).all();
      if (rows.length) {
        outlierResults = rows.map(r =>
          `- "${r.title}" by ${r.channel_title} (${r.outlier_ratio}x outlier, ${r.view_count} views)`
        ).join('\n');
      }
      steps.push({ stage: 'outlier_board', status: 'ok', count: rows.length });
    } catch (e) {
      steps.push({ stage: 'outlier_board', status: 'error', error: e.message });
    }
  }

  const researchPrompt = `You are a market research analyst. Analyze this topic and produce a structured research brief.

TOPIC: ${topic}
CONTENT TYPE: ${contentType}

${webResults ? `WEB RESEARCH:\n${webResults}\n` : ''}
${outlierResults ? `YOUTUBE OUTLIER DATA (proven demand signals):\n${outlierResults}\n` : ''}

Produce a JSON research brief with these fields:
- "angle": the best content angle based on demand signals
- "keywords": array of 5-10 SEO keywords
- "audience": who this content targets
- "competitors": what already exists (from web results)
- "demand_signals": evidence of demand (view counts, trends)
- "content_recommendations": array of specific content ideas
- "product_ideas": array of product concepts if applicable

Return ONLY valid JSON, no markdown fences.`;

  const raw = await chatOllama([
    { role: 'system', content: 'You are a research analyst. Always return valid JSON.' },
    { role: 'user', content: researchPrompt },
  ], { temperature: 0.3 });

  let brief;
  try {
    brief = JSON.parse(raw.replace(/```json\n?|```/g, '').trim());
  } catch {
    brief = { angle: raw, keywords: [], audience: 'general', raw_response: raw };
  }

  return { stage: 'researcher', brief, steps, topic, contentType };
}

// ── Stage 2: Creator (copywriter + image prompts) ───────────────────
export async function runCreator(researchOutput, opts = {}) {
  const { brief, topic, contentType } = researchOutput;
  const type = contentType === 'product' ? 'product' : contentType === 'blog' ? 'blog' : 'both';

  const creatorPrompt = `You are a professional content creator and copywriter. Using this research brief, create commerce-ready content.

RESEARCH BRIEF:
${JSON.stringify(brief, null, 2)}

TOPIC: ${topic}

Create a JSON response with:
${type !== 'blog' ? `
"product": {
  "title": "compelling product title (max 80 chars)",
  "description": "HTML product description (2-3 paragraphs, benefit-driven)",
  "tags": ["tag1", "tag2", ...],
  "seo_title": "SEO-optimized title",
  "seo_description": "meta description (max 160 chars)",
  "image_prompts": ["detailed prompt for product hero image", "lifestyle shot prompt", "detail shot prompt"],
  "price_suggestion": "suggested price range based on market",
  "product_type": "category"
}` : ''}
${type !== 'product' ? `
"blog": {
  "title": "attention-grabbing blog title",
  "body": "full blog post in HTML (800-1200 words, with h2/h3 subheadings)",
  "excerpt": "compelling excerpt (max 200 chars)",
  "tags": ["tag1", "tag2", ...],
  "seo_title": "SEO title",
  "seo_description": "meta description (max 160 chars)",
  "image_prompts": ["hero image prompt", "inline image prompt"]
}` : ''}

Return ONLY valid JSON, no markdown fences.`;

  const raw = await chatOllama([
    { role: 'system', content: 'You are a professional copywriter. Return only valid JSON.' },
    { role: 'user', content: creatorPrompt },
  ], { temperature: 0.7, maxTokens: 4096 });

  let content;
  try {
    content = JSON.parse(raw.replace(/```json\n?|```/g, '').trim());
  } catch {
    content = { raw_response: raw };
  }

  return { stage: 'creator', content, topic };
}

// ── Stage 3: QA Reviewer ────────────────────────────────────────────
export async function runReviewer(creatorOutput, opts = {}) {
  const { content, topic } = creatorOutput;

  const reviewPrompt = `You are a senior content QA editor and SEO specialist. Review this content for quality, accuracy, and commerce-readiness.

CONTENT TO REVIEW:
${JSON.stringify(content, null, 2)}

TOPIC: ${topic}

Check for:
1. Grammar, spelling, tone consistency
2. SEO optimization (keywords in title, headings, meta)
3. Benefit-driven copy (not feature-driven)
4. Call-to-action presence
5. Image prompt quality (specific, detailed, brand-safe)
6. Tag relevance
7. Price positioning (if product)

Return a JSON response:
{
  "approved": true/false,
  "score": 1-10,
  "issues": ["issue1", ...],
  "fixes_applied": {description of any fixes you made},
  "revised_content": {the content with fixes applied — same structure as input}
}

Return ONLY valid JSON, no markdown fences.`;

  const raw = await chatOllama([
    { role: 'system', content: 'You are a QA editor. Return only valid JSON.' },
    { role: 'user', content: reviewPrompt },
  ], { temperature: 0.2 });

  let review;
  try {
    review = JSON.parse(raw.replace(/```json\n?|```/g, '').trim());
  } catch {
    review = { approved: false, score: 0, issues: ['Failed to parse review'], raw_response: raw };
  }

  const finalContent = review.revised_content || content;
  return { stage: 'reviewer', review, finalContent, approved: review.approved !== false, topic };
}

// ── Stage 4: CEO Logger ─────────────────────────────────────────────
export async function runCeoLogger(reviewerOutput, opts = {}) {
  const { review, finalContent, approved, topic } = reviewerOutput;
  const runId = randomUUID();

  db.prepare(`INSERT INTO commerce_pipeline_runs
    (id, topic, content_type, status, score, issues, final_content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runId,
    topic,
    finalContent?.product ? 'product' : finalContent?.blog ? 'blog' : 'mixed',
    approved ? 'approved' : 'needs_revision',
    review?.score || 0,
    JSON.stringify(review?.issues || []),
    JSON.stringify(finalContent),
    now(),
  );

  return {
    stage: 'ceo_logger',
    runId,
    approved,
    score: review?.score,
    issues: review?.issues,
    finalContent,
    topic,
    message: approved
      ? `Content approved (score: ${review?.score}/10). Ready for Shopify.`
      : `Content needs revision (score: ${review?.score}/10). Issues: ${(review?.issues || []).join(', ')}`,
  };
}

// ── Stage 5: Shopify Publisher ──────────────────────────────────────
export async function runShopifyPublish(ceoOutput, opts = {}) {
  const { finalContent, approved, runId, topic } = ceoOutput;
  if (!approved) {
    return { stage: 'shopify', status: 'skipped', reason: 'Content not approved by QA' };
  }

  const shopifyKey = process.env.SHOPIFY_ACCESS_TOKEN;
  const shopifyStore = process.env.SHOPIFY_STORE_DOMAIN;

  if (!shopifyKey || !shopifyStore) {
    return {
      stage: 'shopify',
      status: 'draft',
      reason: 'SHOPIFY_ACCESS_TOKEN and SHOPIFY_STORE_DOMAIN not set in .env',
      finalContent,
      instructions: 'Set these env vars, then re-run the Shopify publish step.',
    };
  }

  const results = { products: [], blogs: [] };
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': shopifyKey,
  };
  const base = `https://${shopifyStore}/admin/api/2024-01`;

  if (finalContent?.product) {
    const p = finalContent.product;
    try {
      const res = await fetch(`${base}/products.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          product: {
            title: p.title,
            body_html: p.description,
            product_type: p.product_type || '',
            tags: (p.tags || []).join(', '),
            status: 'draft',
            metafields_global_title_tag: p.seo_title,
            metafields_global_description_tag: p.seo_description,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();
      if (data.product) {
        results.products.push({ id: data.product.id, title: data.product.title, status: 'draft' });
      } else {
        results.products.push({ error: data.errors || 'Unknown error' });
      }
    } catch (e) {
      results.products.push({ error: e.message });
    }
  }

  if (finalContent?.blog) {
    const b = finalContent.blog;
    try {
      const blogsRes = await fetch(`${base}/blogs.json`, { headers, signal: AbortSignal.timeout(15_000) });
      const blogsData = await blogsRes.json();
      const blogId = blogsData.blogs?.[0]?.id;
      if (!blogId) {
        results.blogs.push({ error: 'No blog found on store. Create one in Shopify admin first.' });
      } else {
        const res = await fetch(`${base}/blogs/${blogId}/articles.json`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            article: {
              title: b.title,
              body_html: b.body,
              summary_html: b.excerpt,
              tags: (b.tags || []).join(', '),
              published: false,
              metafields: [
                { namespace: 'global', key: 'title_tag', value: b.seo_title, type: 'single_line_text_field' },
                { namespace: 'global', key: 'description_tag', value: b.seo_description, type: 'single_line_text_field' },
              ],
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        if (data.article) {
          results.blogs.push({ id: data.article.id, title: data.article.title, status: 'draft' });
        } else {
          results.blogs.push({ error: data.errors || 'Unknown error' });
        }
      }
    } catch (e) {
      results.blogs.push({ error: e.message });
    }
  }

  db.prepare('UPDATE commerce_pipeline_runs SET status = ?, shopify_result = ? WHERE id = ?')
    .run('published_draft', JSON.stringify(results), runId);

  return { stage: 'shopify', status: 'published_draft', results, runId };
}

// ── Full Pipeline Orchestrator ──────────────────────────────────────
export async function runContentCommercePipeline(input, opts = {}) {
  const t0 = Date.now();
  const stages = {};

  try {
    const research = await runResearcher(input, opts);
    stages.researcher = { status: 'ok', data: research, durationMs: Date.now() - t0 };

    const t1 = Date.now();
    const created = await runCreator(research, opts);
    stages.creator = { status: 'ok', data: created, durationMs: Date.now() - t1 };

    const t2 = Date.now();
    const reviewed = await runReviewer(created, opts);
    stages.reviewer = { status: 'ok', data: reviewed, durationMs: Date.now() - t2 };

    const t3 = Date.now();
    const logged = await runCeoLogger(reviewed, opts);
    stages.ceo = { status: 'ok', data: logged, durationMs: Date.now() - t3 };

    if (logged.approved && opts.autoPublish !== false) {
      const t4 = Date.now();
      const published = await runShopifyPublish(logged, opts);
      stages.shopify = { status: 'ok', data: published, durationMs: Date.now() - t4 };
    }

    return {
      status: logged.approved ? 'success' : 'needs_revision',
      stages,
      totalDurationMs: Date.now() - t0,
      runId: logged.runId,
    };
  } catch (e) {
    return {
      status: 'error',
      error: e.message,
      stages,
      totalDurationMs: Date.now() - t0,
    };
  }
}
