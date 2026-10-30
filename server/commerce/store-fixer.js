import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama, parseJSON, shopifyHeaders, shopifyBase } from './shared.js';

const BRAND = {
  name: 'eyeoverthink®',
  trademark: true,
  vendor: 'eyeoverthink®',
  voice: 'confident, creative, streetwear-forward, authentic',
};

// ── Agent 1: Page Generator ──────────────────────────────────────
export async function runPageGenerator(auditData = {}) {
  const missingPages = auditData.missing_pages || ['About', 'FAQ', 'Size Guide', 'Returns', 'Contact'];

  const raw = await chatOllama([
    { role: 'system', content: `You are a Shopify store content specialist for ${BRAND.name}. Brand voice: ${BRAND.voice}. You create compelling store pages that build trust and convert visitors. All content must be original — ${BRAND.name} is a trademarked brand. Respond in JSON.` },
    { role: 'user', content: `Generate content for these missing store pages: ${missingPages.join(', ')}

Brand: ${BRAND.name} — a streetwear and lifestyle brand selling print-on-demand apparel, accessories, and lifestyle products.

For each page generate:
- Title
- SEO meta title (under 60 chars) and meta description (under 155 chars)
- Full HTML body content (use Shopify-compatible HTML, clean formatting, no external CSS)

IMPORTANT: Return ONLY valid JSON. Use escaped quotes inside strings. Do NOT use backtick template literals — use regular double-quoted strings with escaped HTML inside them.

Return JSON:
{
  "pages": [
    {
      "page_key": "about",
      "title": "About ${BRAND.name}",
      "meta_title": "...",
      "meta_description": "...",
      "body_html": "<h2>...</h2><p>...</p>..."
    }
  ]
}

Page requirements:
- About: Brand story, mission, what makes ${BRAND.name} different. Mention original designs and print-on-demand quality.
- FAQ: At least 8 Q&As covering shipping, returns, sizing, materials, care, custom orders, wholesale, and sustainability.
- Size Guide: Detailed size chart for unisex tees (S-3XL), hoodies (S-3XL), and headwear. Include measurement instructions.
- Returns: Clear 30-day return policy, exchange process, refund timeline, and conditions. Build trust.
- Contact: Contact form description, email, response time (24-48 hours), social media links placeholders.` },
  ], { temperature: 0.4, maxTokens: 6144 });

  const parsed = parseJSON(raw);
  if (parsed.raw && !parsed.pages) {
    const pageMatches = raw.match(/"page_key"\s*:\s*"(\w+)"/g);
    if (pageMatches) {
      parsed.pages_detected = pageMatches.length;
      parsed.note = 'Pages generated but LLM returned non-standard JSON. Content is in the raw field.';
    }
  }
  return { agent: 'page_generator', ...parsed };
}

// ── Agent 2: Collection Organizer ────────────────────────────────
export async function runCollectionOrganizer(auditData = {}) {
  const raw = await chatOllama([
    { role: 'system', content: `You are a Shopify merchandising specialist for ${BRAND.name}. You organize products into intuitive collections that improve browsability and conversion. Respond in JSON.` },
    { role: 'user', content: `Reorganize the store's collections for better product discovery.

Current issues from audit:
${JSON.stringify(auditData.collections || auditData.product_discovery || {}, null, 2)}

Our product categories include: tees, v-necks, long-sleeves, tank tops, hoodies, zip hoodies, crewneck sweatshirts, bomber jackets, denim jackets, windbreakers, joggers, shorts, slides, high-top sneakers, trucker hats, beanies, dad hats, phone cases, airpods cases, tote bags, backpacks, mugs, sticker sheets, posters.

Create a smart collection structure. Return JSON:
{
  "collections": [
    {
      "title": "Tops",
      "handle": "tops",
      "description": "...",
      "rules": [{"column": "tag", "relation": "equals", "condition": "tops"}],
      "sort_order": "best-selling",
      "seo_title": "...",
      "seo_description": "..."
    }
  ],
  "navigation_menu": [
    {"label": "Shop All", "handle": "all"},
    {"label": "Tops", "handle": "tops", "children": [
      {"label": "Tees", "handle": "tees"},
      {"label": "Hoodies", "handle": "hoodies"}
    ]}
  ],
  "product_tag_updates": [
    {"product_type": "unisex-tee", "add_tags": ["tops", "tees", "essentials"]}
  ]
}` },
  ], { temperature: 0.3, maxTokens: 4096 });

  return { agent: 'collection_organizer', ...parseJSON(raw) };
}

// ── Agent 3: Description Enhancer ────────────────────────────────
export async function runDescriptionEnhancer(auditData = {}) {
  const raw = await chatOllama([
    { role: 'system', content: `You are a copywriter for ${BRAND.name}. Brand voice: ${BRAND.voice}. You write product descriptions that are compelling, SEO-optimized, and conversion-focused. Each description should feel premium but approachable. Respond in JSON.` },
    { role: 'user', content: `Generate enhanced product description templates for our main product categories.

Current issues: ${JSON.stringify(auditData.product_presentation || auditData.product_pages || {}, null, 2)}

For each product type, create a reusable description template with:
- Compelling headline
- 2-3 sentence description highlighting materials, fit, and brand
- Feature bullets (3-5)
- Care instructions
- SEO keywords

Return JSON:
{
  "templates": [
    {
      "product_type": "unisex-tee",
      "headline": "...",
      "description_html": "<p>...</p>",
      "features": ["..."],
      "care": "...",
      "seo_keywords": ["..."]
    }
  ]
}

Cover at minimum: unisex-tee, hoodie, bomber-jacket, slides, trucker-hat, phone-case, tote-bag, mug` },
  ], { temperature: 0.5, maxTokens: 4096 });

  return { agent: 'description_enhancer', ...parseJSON(raw) };
}

// ── Agent 4: Price Adjuster ──────────────────────────────────────
export async function runPriceAdjuster(auditData = {}) {
  const marginAnalysis = auditData.margin_analysis || [];
  const underpriced = marginAnalysis.filter(p => p.verdict === 'underpriced');

  if (underpriced.length === 0) {
    return {
      agent: 'price_adjuster',
      adjustments: [],
      message: 'No underpriced products found — margins look healthy.',
    };
  }

  const raw = await chatOllama([
    { role: 'system', content: `You are a pricing strategist for ${BRAND.name}. You optimize prices for maximum margin while staying competitive in the POD streetwear market. Target margin: 50-65%. Respond in JSON.` },
    { role: 'user', content: `These products are underpriced. Suggest optimal price adjustments:

${JSON.stringify(underpriced, null, 2)}

For each product:
1. Calculate the optimal price for 55-60% target margin
2. Suggest a compare-at price for perceived value (usually 20-30% higher than the new price)
3. Consider psychological pricing ($X.99)

Return JSON:
{
  "adjustments": [
    {
      "product": "...",
      "current_price": 0,
      "estimated_cost": 0,
      "new_price": 0,
      "compare_at_price": 0,
      "new_margin_pct": 0,
      "rationale": "..."
    }
  ],
  "total_revenue_impact": "estimated % increase in revenue from price adjustments"
}` },
  ], { temperature: 0.3, maxTokens: 2048 });

  return { agent: 'price_adjuster', ...parseJSON(raw) };
}

// ── Agent 5: Shopify Applier ─────────────────────────────────────
export async function runShopifyApplier(pages, collections, descriptions, prices, opts = {}) {
  const headers = shopifyHeaders();
  const base = shopifyBase();
  const applied = { pages: [], collections: [], descriptions: [], prices: [] };

  if (!headers || !base) {
    return {
      agent: 'shopify_applier',
      status: 'queued',
      message: 'Shopify credentials not configured — fixes generated and queued. Set SHOPIFY_ACCESS_TOKEN and SHOPIFY_STORE_DOMAIN to apply.',
      queued: {
        pages: pages?.pages?.length || 0,
        collections: collections?.collections?.length || 0,
        description_templates: descriptions?.templates?.length || 0,
        price_adjustments: prices?.adjustments?.length || 0,
      },
      data: { pages, collections, descriptions, prices },
    };
  }

  // Apply pages
  if (pages?.pages?.length) {
    for (const page of pages.pages) {
      try {
        const res = await fetch(`${base}/pages.json`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            page: {
              title: page.title,
              body_html: page.body_html,
              metafields_global_title_tag: page.meta_title,
              metafields_global_description_tag: page.meta_description,
              published: !opts.draft,
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json();
        applied.pages.push({ title: page.title, status: res.ok ? 'created' : 'error', id: data.page?.id, error: data.errors });
      } catch (e) {
        applied.pages.push({ title: page.title, status: 'error', error: e.message });
      }
    }
  }

  // Apply smart collections
  if (collections?.collections?.length) {
    for (const coll of collections.collections) {
      try {
        const res = await fetch(`${base}/smart_collections.json`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            smart_collection: {
              title: coll.title,
              body_html: `<p>${coll.description || ''}</p>`,
              rules: coll.rules || [],
              sort_order: coll.sort_order || 'best-selling',
              published: !opts.draft,
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json();
        applied.collections.push({ title: coll.title, status: res.ok ? 'created' : 'error', id: data.smart_collection?.id, error: data.errors });
      } catch (e) {
        applied.collections.push({ title: coll.title, status: 'error', error: e.message });
      }
    }
  }

  // Apply price adjustments
  if (prices?.adjustments?.length) {
    try {
      const productsRes = await fetch(`${base}/products.json?limit=250`, { headers, signal: AbortSignal.timeout(15_000) });
      const { products } = await productsRes.json();

      for (const adj of prices.adjustments) {
        const product = products?.find(p =>
          p.title.toLowerCase().includes(adj.product.toLowerCase()) ||
          p.product_type?.toLowerCase().includes(adj.product.toLowerCase().replace(/\s+/g, '-'))
        );
        if (!product) {
          applied.prices.push({ product: adj.product, status: 'not_found' });
          continue;
        }
        for (const variant of product.variants || []) {
          try {
            const res = await fetch(`${base}/variants/${variant.id}.json`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                variant: {
                  id: variant.id,
                  price: String(adj.new_price),
                  compare_at_price: adj.compare_at_price ? String(adj.compare_at_price) : null,
                },
              }),
              signal: AbortSignal.timeout(10_000),
            });
            applied.prices.push({ product: adj.product, variant_id: variant.id, status: res.ok ? 'updated' : 'error' });
          } catch (e) {
            applied.prices.push({ product: adj.product, status: 'error', error: e.message });
          }
        }
      }
    } catch (e) {
      applied.prices.push({ status: 'error', error: `Failed to fetch products: ${e.message}` });
    }
  }

  return { agent: 'shopify_applier', status: 'applied', applied };
}

// ── Full Store Fixer Pipeline ────────────────────────────────────
export async function runStoreFixerPipeline(auditReport = {}, opts = {}) {
  const t0 = Date.now();
  const runId = randomUUID();
  const stages = {};

  try {
    // Stage 1 & 2 & 3 run in parallel — they're independent
    const t1 = Date.now();
    const [pages, collections, descriptions] = await Promise.all([
      runPageGenerator(auditReport),
      runCollectionOrganizer(auditReport),
      runDescriptionEnhancer(auditReport),
    ]);
    stages.page_generator = { status: 'ok', data: pages, durationMs: Date.now() - t1 };
    stages.collection_organizer = { status: 'ok', data: collections, durationMs: Date.now() - t1 };
    stages.description_enhancer = { status: 'ok', data: descriptions, durationMs: Date.now() - t1 };

    // Stage 4: Price adjustments (needs audit pricing data)
    const t4 = Date.now();
    const prices = await runPriceAdjuster(auditReport);
    stages.price_adjuster = { status: 'ok', data: prices, durationMs: Date.now() - t4 };

    // Stage 5: Apply everything to Shopify (or queue it)
    const t5 = Date.now();
    const applied = await runShopifyApplier(pages, collections, descriptions, prices, opts);
    stages.shopify_applier = { status: 'ok', data: applied, durationMs: Date.now() - t5 };

    // Log to database
    db.prepare(`INSERT INTO store_fixer_runs
      (id, audit_run_id, pages_generated, collections_created, templates_created, prices_adjusted, apply_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      runId,
      auditReport.runId || 'manual',
      pages?.pages?.length || 0,
      collections?.collections?.length || 0,
      descriptions?.templates?.length || 0,
      prices?.adjustments?.length || 0,
      applied.status,
    );

    return {
      status: 'success',
      runId,
      stages,
      totalDurationMs: Date.now() - t0,
      summary: {
        pages: pages?.pages?.length || 0,
        collections: collections?.collections?.length || 0,
        templates: descriptions?.templates?.length || 0,
        priceAdjustments: prices?.adjustments?.length || 0,
        applyStatus: applied.status,
      },
    };
  } catch (e) {
    return { status: 'error', runId, error: e.message, stages, totalDurationMs: Date.now() - t0 };
  }
}
