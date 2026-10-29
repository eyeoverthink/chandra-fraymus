import { OLLAMA_URL } from '../config.js';
import { db } from '../db.js';
import { randomUUID } from 'node:crypto';

const PRINTIFY_BASE = 'https://api.printify.com/v1';

function printifyHeaders() {
  const token = process.env.PRINTIFY_ACCESS_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function shopifyHeaders() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };
}

function shopifyBase() {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  return store ? `https://${store}/admin/api/2024-01` : null;
}

async function chatOllama(messages, opts = {}) {
  const url = process.env.OLLAMA_BASE_URL || OLLAMA_URL || 'http://127.0.0.1:11434';
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || process.env.FRAYMUS_DEFAULT_MODEL || 'llama3.2',
      messages,
      stream: false,
      options: { temperature: opts.temperature ?? 0.7, num_predict: opts.maxTokens ?? 2048 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

function parseJSON(raw) {
  // Try direct parse first
  try { return JSON.parse(raw.trim()); } catch {}
  // Strip markdown code fences and try again
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Last resort: find the first { ... } block
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  return { raw };
}

// ── Brand constants ───────────────────────────────────────────────
const BRAND = {
  name: 'eyeoverthink®',
  trademark: true,
  vendor: 'eyeoverthink®',
  tags_base: ['eyeoverthink', 'streetwear', 'original-design'],
};

const PRODUCT_TYPES = [
  'unisex-tee', 'v-neck-tee', 'long-sleeve-tee', 'tank-top',
  'hoodie', 'zip-hoodie', 'crewneck-sweatshirt',
  'bomber-jacket', 'denim-jacket', 'windbreaker',
  'joggers', 'shorts',
  'slides', 'high-top-sneakers',
  'trucker-hat', 'beanie', 'dad-hat',
  'phone-case', 'airpods-case',
  'tote-bag', 'backpack',
  'mug', 'sticker-sheet', 'poster',
];

// ── Stage 1: Trend Scout ──────────────────────────────────────────
export async function runTrendScout(input, opts = {}) {
  const { niche, season, productTypes } = input;

  let outlierData = '';
  try {
    const rows = db.prepare(
      'SELECT * FROM outlier_board ORDER BY outlier_score DESC LIMIT 20'
    ).all();
    if (rows.length) {
      outlierData = `\nYouTube Outlier Board top trends:\n${rows.map(r =>
        `- "${r.title}" (score: ${r.outlier_score}, views: ${r.view_count})`
      ).join('\n')}`;
    }
  } catch {}

  let webTrends = '';
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(`${niche || 'streetwear'} apparel trends ${season || '2026'}`)}&format=json&no_html=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const data = await res.json();
    if (data.RelatedTopics?.length) {
      webTrends = `\nWeb trends:\n${data.RelatedTopics.slice(0, 10).map(t => `- ${t.Text}`).join('\n')}`;
    }
  } catch {}

  const raw = await chatOllama([
    { role: 'system', content: `You are a fashion trend analyst for the brand ${BRAND.name}. Analyze trends and recommend apparel designs. Respond in JSON.` },
    { role: 'user', content: `Analyze current apparel trends for: ${niche || 'streetwear / tech culture'}.
Season: ${season || 'all-season'}
Product types to consider: ${(productTypes || PRODUCT_TYPES.slice(0, 10)).join(', ')}
${outlierData}${webTrends}

Return JSON:
{
  "trends": [{"name": "...", "description": "...", "confidence": 0-1}],
  "recommended_products": [
    {
      "product_type": "hoodie|tee|...",
      "design_concept": "description of the design",
      "slogan": "catchy text for the product",
      "target_audience": "who buys this",
      "color_palette": ["#hex", ...],
      "estimated_demand": "high|medium|low"
    }
  ],
  "seasonal_notes": "...",
  "pricing_insights": "..."
}` },
  ], { temperature: 0.8 });

  return { stage: 'trend_scout', ...parseJSON(raw) };
}

// ── Stage 2: Designer ─────────────────────────────────────────────
export async function runDesigner(trendData, opts = {}) {
  const products = trendData.recommended_products || [];
  if (!products.length) return { stage: 'designer', products: [], error: 'No products from trend scout' };

  const raw = await chatOllama([
    { role: 'system', content: `You are an apparel product designer for ${BRAND.name}. Create detailed product listings from trend recommendations. All designs must feature the ${BRAND.name} brand. Respond in JSON.` },
    { role: 'user', content: `Create detailed product listings for these recommended products:
${JSON.stringify(products, null, 2)}

For each product return:
{
  "products": [
    {
      "title": "eyeoverthink® Product Name",
      "product_type": "hoodie|tee|...",
      "description_html": "<p>SEO-rich product description</p>",
      "tags": ["tag1", "tag2"],
      "variants": {
        "sizes": ["S", "M", "L", "XL", "2XL", "3XL"],
        "colors": [{"name": "Black", "hex": "#000000"}]
      },
      "design_spec": {
        "placement": "front-center|back-full|left-chest|all-over",
        "design_description": "exact description of what goes on the garment",
        "text_elements": ["slogan or text on the product"],
        "style": "minimal|bold|vintage|streetwear|abstract"
      },
      "seo_title": "...",
      "seo_description": "...",
      "collection": "Tees|Hoodies & Sweatshirts|Accessories|Jackets|Footwear|Headwear",
      "base_cost_estimate": 12.50,
      "suggested_retail": 24.99
    }
  ]
}` },
  ], { temperature: 0.6, maxTokens: 4096 });

  const result = parseJSON(raw);
  return { stage: 'designer', ...result };
}

// ── Stage 3: Printify Push ────────────────────────────────────────
export async function runPrintifyPush(designerOutput, opts = {}) {
  const headers = printifyHeaders();
  const products = designerOutput.products || [];

  if (!headers) {
    return {
      stage: 'printify',
      status: 'skipped',
      reason: 'PRINTIFY_ACCESS_TOKEN not set',
      products: products.map(p => ({
        title: p.title,
        status: 'draft_local',
        instruction: 'Set PRINTIFY_ACCESS_TOKEN in .env to push to Printify',
      })),
    };
  }

  let shopId = process.env.PRINTIFY_SHOP_ID;
  if (!shopId) {
    try {
      const res = await fetch(`${PRINTIFY_BASE}/shops.json`, { headers, signal: AbortSignal.timeout(15_000) });
      const shops = await res.json();
      shopId = shops?.[0]?.id;
    } catch {}
  }
  if (!shopId) {
    return { stage: 'printify', status: 'error', error: 'No Printify shop found' };
  }

  const results = [];
  for (const product of products) {
    try {
      const blueprintId = mapProductTypeToBlueprint(product.product_type);
      const providerId = opts.printProviderId || 99; // default provider

      const printifyProduct = {
        title: product.title,
        description: product.description_html || product.description || '',
        blueprint_id: blueprintId,
        print_provider_id: providerId,
        variants: buildPrintifyVariants(product.variants, blueprintId, providerId),
        print_areas: [{
          variant_ids: [], // filled by variants
          placeholders: [{
            position: mapPlacement(product.design_spec?.placement),
            images: [{
              id: 'placeholder',
              x: 0.5, y: 0.5,
              scale: 1,
              angle: 0,
            }],
          }],
        }],
        tags: [...BRAND.tags_base, ...(product.tags || [])],
      };

      const res = await fetch(`${PRINTIFY_BASE}/shops/${shopId}/products.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify(printifyProduct),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();

      results.push({
        title: product.title,
        printify_id: data.id,
        status: data.id ? 'created' : 'error',
        error: data.id ? null : JSON.stringify(data),
      });
    } catch (e) {
      results.push({ title: product.title, status: 'error', error: e.message });
    }
  }

  return { stage: 'printify', status: 'pushed', shopId, results };
}

function mapProductTypeToBlueprint(type) {
  const map = {
    'unisex-tee': 6, 'v-neck-tee': 38, 'long-sleeve-tee': 43, 'tank-top': 35,
    'hoodie': 77, 'zip-hoodie': 103, 'crewneck-sweatshirt': 180,
    'bomber-jacket': 514, 'denim-jacket': 515,
    'joggers': 426, 'shorts': 503,
    'slides': 557, 'high-top-sneakers': 573,
    'trucker-hat': 376, 'beanie': 432, 'dad-hat': 502,
    'phone-case': 20, 'airpods-case': 564,
    'tote-bag': 36, 'backpack': 534,
    'mug': 68, 'sticker-sheet': 552, 'poster': 1,
  };
  return map[type] || 6;
}

function mapPlacement(placement) {
  const map = {
    'front-center': 'front', 'back-full': 'back', 'left-chest': 'front',
    'all-over': 'front', 'front': 'front', 'back': 'back',
  };
  return map[placement] || 'front';
}

function buildPrintifyVariants(variants, blueprintId, providerId) {
  const sizes = variants?.sizes || ['S', 'M', 'L', 'XL', '2XL'];
  const colors = variants?.colors || [{ name: 'Black', hex: '#000000' }];

  return sizes.flatMap((size, si) =>
    colors.map((color, ci) => ({
      id: si * 100 + ci + 1,
      price: 0, // set by pricing engine
      is_enabled: true,
    }))
  );
}

// ── Stage 4: Shopify Sync ─────────────────────────────────────────
export async function runShopifySync(printifyOutput, designerOutput, opts = {}) {
  const headers = shopifyHeaders();
  const base = shopifyBase();

  if (!headers || !base) {
    return {
      stage: 'shopify_sync',
      status: 'skipped',
      reason: 'SHOPIFY_ACCESS_TOKEN or SHOPIFY_STORE_DOMAIN not set',
    };
  }

  const products = designerOutput?.products || [];
  const printifyResults = printifyOutput?.results || [];
  const results = [];

  // Ensure collections exist
  const collectionsNeeded = [...new Set(products.map(p => p.collection).filter(Boolean))];
  const existingCollections = await fetchExistingCollections(headers, base);

  for (const collName of collectionsNeeded) {
    if (!existingCollections.find(c => c.title.toLowerCase() === collName.toLowerCase())) {
      await createSmartCollection(headers, base, collName);
    }
  }

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const printifyMatch = printifyResults[i];

    try {
      const shopifyProduct = {
        product: {
          title: product.title,
          body_html: product.description_html || product.description || '',
          vendor: BRAND.vendor,
          product_type: product.product_type || '',
          tags: [...BRAND.tags_base, ...(product.tags || [])].join(', '),
          status: 'draft',
          metafields_global_title_tag: product.seo_title,
          metafields_global_description_tag: product.seo_description,
          variants: buildShopifyVariants(product),
        },
      };

      const res = await fetch(`${base}/products.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify(shopifyProduct),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();

      results.push({
        title: product.title,
        shopify_id: data.product?.id,
        printify_id: printifyMatch?.printify_id,
        status: data.product?.id ? 'synced_draft' : 'error',
        error: data.product?.id ? null : JSON.stringify(data.errors || data),
      });
    } catch (e) {
      results.push({ title: product.title, status: 'error', error: e.message });
    }
  }

  return { stage: 'shopify_sync', status: 'synced', results };
}

async function fetchExistingCollections(headers, base) {
  try {
    const res = await fetch(`${base}/smart_collections.json`, { headers, signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    const custom = await fetch(`${base}/custom_collections.json`, { headers, signal: AbortSignal.timeout(15_000) });
    const customData = await custom.json();
    return [...(data.smart_collections || []), ...(customData.custom_collections || [])];
  } catch { return []; }
}

async function createSmartCollection(headers, base, title) {
  const rules = collectionRules(title);
  try {
    await fetch(`${base}/smart_collections.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ smart_collection: { title, rules, disjunctive: true } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {}
}

function collectionRules(title) {
  const ruleMap = {
    'Tees': [{ column: 'type', relation: 'contains', condition: 'tee' }],
    'Hoodies & Sweatshirts': [
      { column: 'type', relation: 'contains', condition: 'hoodie' },
      { column: 'type', relation: 'contains', condition: 'sweatshirt' },
    ],
    'Jackets': [
      { column: 'type', relation: 'contains', condition: 'jacket' },
      { column: 'type', relation: 'contains', condition: 'bomber' },
      { column: 'type', relation: 'contains', condition: 'windbreaker' },
    ],
    'Footwear': [
      { column: 'type', relation: 'contains', condition: 'slide' },
      { column: 'type', relation: 'contains', condition: 'sneaker' },
    ],
    'Headwear': [
      { column: 'type', relation: 'contains', condition: 'hat' },
      { column: 'type', relation: 'contains', condition: 'beanie' },
    ],
    'Accessories': [
      { column: 'type', relation: 'contains', condition: 'mug' },
      { column: 'type', relation: 'contains', condition: 'sticker' },
      { column: 'type', relation: 'contains', condition: 'case' },
      { column: 'type', relation: 'contains', condition: 'bag' },
    ],
  };
  return ruleMap[title] || [{ column: 'tag', relation: 'equals', condition: title.toLowerCase() }];
}

function buildShopifyVariants(product) {
  const sizes = product.variants?.sizes || ['S', 'M', 'L', 'XL', '2XL'];
  const colors = product.variants?.colors || [{ name: 'Black' }];
  const price = product.suggested_retail || 24.99;

  return sizes.flatMap(size =>
    colors.map(color => ({
      option1: size,
      option2: color.name,
      price: String(price),
      inventory_management: null,
      fulfillment_service: 'manual',
    }))
  );
}

// ── Stage 5: Pricing Engine ───────────────────────────────────────
export async function runPricingEngine(shopifySyncOutput, designerOutput, opts = {}) {
  const products = designerOutput?.products || [];
  const syncResults = shopifySyncOutput?.results || [];

  const raw = await chatOllama([
    { role: 'system', content: `You are a pricing strategist for ${BRAND.name} print-on-demand apparel. Analyze costs and set competitive prices. Respond in JSON.` },
    { role: 'user', content: `Review and optimize pricing for these products:
${JSON.stringify(products.map(p => ({
  title: p.title,
  type: p.product_type,
  base_cost: p.base_cost_estimate,
  current_retail: p.suggested_retail,
})), null, 2)}

Consider:
- Printify base costs (tees: $8-12, hoodies: $18-25, jackets: $28-40, shoes: $35-55, hats: $10-15, mugs: $5-8)
- Target margin: 40-60%
- Competitor pricing for POD streetwear brands
- Bundle pricing opportunities (buy 2+ discount)

Return JSON:
{
  "pricing": [
    {
      "title": "...",
      "base_cost": 12.50,
      "recommended_price": 29.99,
      "margin_percent": 58,
      "compare_at_price": 34.99,
      "reasoning": "..."
    }
  ],
  "bundle_suggestions": [
    {"name": "Starter Pack", "products": ["..."], "discount_percent": 15}
  ]
}` },
  ], { temperature: 0.4 });

  const pricing = parseJSON(raw);

  // Update Shopify prices if connected
  const headers = shopifyHeaders();
  const base = shopifyBase();
  if (headers && base && pricing.pricing) {
    for (let i = 0; i < syncResults.length; i++) {
      const sync = syncResults[i];
      const priceInfo = pricing.pricing[i];
      if (sync?.shopify_id && priceInfo?.recommended_price) {
        try {
          await fetch(`${base}/products/${sync.shopify_id}.json`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              product: {
                id: sync.shopify_id,
                variants: [{ price: String(priceInfo.recommended_price) }],
              },
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch {}
      }
    }
  }

  return { stage: 'pricing', ...pricing };
}

// ── Full Apparel Pipeline Orchestrator ────────────────────────────
export async function runApparelPipeline(input, opts = {}) {
  const t0 = Date.now();
  const runId = randomUUID();
  const stages = {};

  db.prepare(`INSERT INTO apparel_pipeline_runs (id, niche, product_types, status, created_at)
    VALUES (?, ?, ?, 'running', datetime('now'))`).run(
    runId, input.niche || 'streetwear', JSON.stringify(input.productTypes || [])
  );

  try {
    const t1 = Date.now();
    const trends = await runTrendScout(input, opts);
    stages.trend_scout = { status: 'ok', data: trends, durationMs: Date.now() - t1 };

    const t2 = Date.now();
    const designs = await runDesigner(trends, opts);
    stages.designer = { status: 'ok', data: designs, durationMs: Date.now() - t2 };

    const t3 = Date.now();
    const printify = await runPrintifyPush(designs, opts);
    stages.printify = { status: 'ok', data: printify, durationMs: Date.now() - t3 };

    const t4 = Date.now();
    const shopify = await runShopifySync(printify, designs, opts);
    stages.shopify_sync = { status: 'ok', data: shopify, durationMs: Date.now() - t4 };

    const t5 = Date.now();
    const pricing = await runPricingEngine(shopify, designs, opts);
    stages.pricing = { status: 'ok', data: pricing, durationMs: Date.now() - t5 };

    db.prepare('UPDATE apparel_pipeline_runs SET status = ?, stages = ?, products_created = ? WHERE id = ?')
      .run('success', JSON.stringify(stages), designs.products?.length || 0, runId);

    return {
      status: 'success',
      runId,
      stages,
      totalDurationMs: Date.now() - t0,
      productsCreated: designs.products?.length || 0,
    };
  } catch (e) {
    db.prepare('UPDATE apparel_pipeline_runs SET status = ?, stages = ? WHERE id = ?')
      .run('error', JSON.stringify({ ...stages, error: e.message }), runId);

    return { status: 'error', runId, error: e.message, stages, totalDurationMs: Date.now() - t0 };
  }
}
