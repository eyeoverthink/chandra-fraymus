import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama, parseJSON, shopifyHeaders, shopifyBase } from './shared.js';

// ── Agent 1: Shopper ──────────────────────────────────────────────
export async function runShopperAgent(input = {}) {
  const storeUrl = input.storeUrl || `https://${process.env.SHOPIFY_STORE_DOMAIN || 'eyeoverthink.myshopify.com'}`;

  // Fetch store data via Shopify API for the agent to analyze
  const h = shopifyHeaders();
  const base = shopifyBase();
  let storeData = '';

  if (h && base) {
    try {
      const [productsRes, collectionsRes] = await Promise.all([
        fetch(`${base}/products.json?status=active&limit=50`, { headers: h, signal: AbortSignal.timeout(15_000) }),
        fetch(`${base}/smart_collections.json`, { headers: h, signal: AbortSignal.timeout(15_000) }),
      ]);
      const products = await productsRes.json();
      const collections = await collectionsRes.json();
      storeData = `
Active products (${products.products?.length || 0}):
${(products.products || []).map(p => `- "${p.title}" — $${p.variants?.[0]?.price || '?'} — ${p.tags || 'no tags'} — images: ${p.images?.length || 0}`).join('\n')}

Collections (${collections.smart_collections?.length || 0}):
${(collections.smart_collections || []).map(c => `- "${c.title}" — ${c.products_count || 0} products`).join('\n')}`;
    } catch (e) {
      storeData = `\n(Could not fetch store data: ${e.message})`;
    }
  }

  const raw = await chatOllama([
    { role: 'system', content: `You are a mystery shopper evaluating an online apparel store. You are thorough, honest, and think like a real customer. Evaluate the store as if you just arrived from a Google search or social media ad. Respond in JSON.` },
    { role: 'user', content: `Evaluate this Shopify store: ${storeUrl}

Store data:
${storeData}

Evaluate as a mystery shopper:
1. First impression — would you stay or bounce?
2. Product discovery — can you find what you want easily?
3. Product presentation — are descriptions compelling? Images clear?
4. Pricing — does it feel fair for the brand?
5. Trust signals — does it feel legit? Returns policy visible?
6. Mobile readiness — any potential issues?
7. Brand consistency — does everything feel cohesive?

Return JSON:
{
  "overall_score": 1-10,
  "would_buy": true/false,
  "first_impression": {"score": 1-10, "notes": "..."},
  "product_discovery": {"score": 1-10, "issues": ["..."], "suggestions": ["..."]},
  "product_presentation": {"score": 1-10, "issues": ["..."], "suggestions": ["..."]},
  "pricing_perception": {"score": 1-10, "notes": "..."},
  "trust_signals": {"score": 1-10, "missing": ["..."]},
  "brand_consistency": {"score": 1-10, "notes": "..."},
  "top_3_fixes": ["most impactful fix first", "...", "..."],
  "top_3_strengths": ["...", "...", "..."]
}` },
  ], { temperature: 0.5 });

  return { agent: 'shopper', ...parseJSON(raw) };
}

// ── Agent 2: UX Auditor ───────────────────────────────────────────
export async function runUxAuditor(shopperReport, input = {}) {
  const raw = await chatOllama([
    { role: 'system', content: `You are a UX/conversion rate optimization specialist auditing an e-commerce store. You focus on actionable improvements that increase conversion. Respond in JSON.` },
    { role: 'user', content: `Based on this mystery shopper report, perform a deep UX audit:
${JSON.stringify(shopperReport, null, 2)}

Focus on:
1. Navigation flow — is the path to purchase clear?
2. Collection organization — are products logically grouped?
3. Product page optimization — description length, CTA placement, size guides
4. Cart and checkout friction points
5. Cross-sell / upsell opportunities
6. SEO metadata quality
7. Missing pages (About, FAQ, Size Guide, Returns, Contact)

Return JSON:
{
  "conversion_score": 1-10,
  "navigation": {"grade": "A-F", "issues": [], "fixes": []},
  "collections": {"grade": "A-F", "missing": [], "reorganize": []},
  "product_pages": {"grade": "A-F", "improvements": []},
  "checkout": {"grade": "A-F", "friction_points": []},
  "cross_sell": {"opportunities": []},
  "seo": {"grade": "A-F", "fixes": []},
  "missing_pages": ["..."],
  "priority_action_plan": [
    {"action": "...", "impact": "high|medium|low", "effort": "high|medium|low", "expected_lift": "..."}
  ]
}` },
  ], { temperature: 0.4 });

  return { agent: 'ux_auditor', ...parseJSON(raw) };
}

// ── Agent 3: Price Analyst ────────────────────────────────────────
export async function runPriceAnalyst(shopperReport, input = {}) {
  const raw = await chatOllama([
    { role: 'system', content: `You are a competitive pricing analyst for print-on-demand apparel. You know Printify base costs and market pricing. Respond in JSON.` },
    { role: 'user', content: `Analyze the pricing strategy based on this data:
${JSON.stringify(shopperReport, null, 2)}

Known Printify base costs for reference:
- Unisex tees: $8-12
- V-neck tees: $9-13
- Hoodies: $18-25
- Zip hoodies: $22-28
- Bomber jackets: $28-40
- Slides: $12-18
- High-tops: $35-55
- Mugs: $5-8
- Phone cases: $6-10
- Trucker hats: $10-15
- Stickers: $2-5

Evaluate:
1. Current prices vs market rate for POD streetwear
2. Margin analysis (estimated Printify cost vs retail)
3. Price anchoring opportunities (compare-at prices)
4. Bundle pricing potential
5. Premium vs value positioning

Return JSON:
{
  "pricing_grade": "A-F",
  "margin_analysis": [
    {"product": "...", "estimated_cost": 12, "current_price": 23.50, "margin_pct": 49, "verdict": "fair|underpriced|overpriced", "suggested_price": 24.99}
  ],
  "positioning": "premium|mid-range|value",
  "suggested_positioning": "...",
  "bundle_ideas": [{"name": "...", "items": [], "price": 0, "savings_pct": 0}],
  "compare_at_strategy": "...",
  "seasonal_pricing_tips": "..."
}` },
  ], { temperature: 0.4 });

  return { agent: 'price_analyst', ...parseJSON(raw) };
}

// ── Agent 4: Report + Auto-Fix ────────────────────────────────────
export async function runReportAndFix(shopperReport, uxReport, priceReport, opts = {}) {
  const runId = randomUUID();

  const raw = await chatOllama([
    { role: 'system', content: `You are the quality director for ${process.env.BRAND_NAME || 'eyeoverthink®'}. Synthesize all agent reports into a prioritized action plan. Some fixes can be automated, others need human approval. Respond in JSON.` },
    { role: 'user', content: `Synthesize these three audit reports into a unified action plan:

SHOPPER REPORT:
${JSON.stringify(shopperReport, null, 2)}

UX AUDIT:
${JSON.stringify(uxReport, null, 2)}

PRICE ANALYSIS:
${JSON.stringify(priceReport, null, 2)}

Create:
1. Executive summary (2-3 sentences)
2. Automated fixes (things we can do via API right now)
3. Manual fixes (need human design or decisions)
4. Strategic recommendations (longer-term)

Return JSON:
{
  "executive_summary": "...",
  "overall_store_grade": "A-F",
  "scores": {
    "shopper": 0, "ux": 0, "pricing": 0, "overall": 0
  },
  "automated_fixes": [
    {"action": "update_tags", "target": "product_id or 'all'", "details": "...", "can_auto_apply": true}
  ],
  "manual_fixes": [
    {"action": "...", "priority": "high|medium|low", "details": "..."}
  ],
  "strategic": [
    {"recommendation": "...", "timeline": "this week|this month|next quarter", "impact": "..."}
  ]
}` },
  ], { temperature: 0.3, maxTokens: 4096 });

  const report = parseJSON(raw);

  // Log to database
  db.prepare(`INSERT INTO mystery_shopper_runs
    (id, store_domain, overall_grade, scores, automated_fixes, manual_fixes, strategic, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    runId,
    process.env.SHOPIFY_STORE_DOMAIN || 'unknown',
    report.overall_store_grade || 'N/A',
    JSON.stringify(report.scores || {}),
    JSON.stringify(report.automated_fixes || []),
    JSON.stringify(report.manual_fixes || []),
    JSON.stringify(report.strategic || []),
  );

  // Apply automated fixes if approved
  if (opts.autoApply && report.automated_fixes?.length) {
    const applied = await applyAutomatedFixes(report.automated_fixes);
    report._applied = applied;
  }

  return { runId, agent: 'report_and_fix', ...report };
}

async function applyAutomatedFixes(fixes) {
  const headers = shopifyHeaders();
  const base = shopifyBase();
  if (!headers || !base) return { skipped: true, reason: 'Shopify credentials not set' };

  let products = null;
  async function getProducts() {
    if (products) return products;
    try {
      const res = await fetch(`${base}/products.json?limit=250`, { headers, signal: AbortSignal.timeout(15_000) });
      const data = await res.json();
      products = data.products || [];
    } catch { products = []; }
    return products;
  }

  const applied = [];

  for (const fix of fixes) {
    if (!fix.can_auto_apply) continue;
    try {
      if (fix.action === 'update_tags') {
        const all = await getProducts();
        const targets = fix.target === 'all' ? all : all.filter(p => String(p.id) === String(fix.target));
        for (const p of targets) {
          const newTags = p.tags ? `${p.tags}, ${fix.details}` : fix.details;
          const res = await fetch(`${base}/products/${p.id}.json`, {
            method: 'PUT', headers,
            body: JSON.stringify({ product: { id: p.id, tags: newTags } }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`Shopify ${res.status}`);
        }
        applied.push({ action: fix.action, status: 'applied', count: targets.length, details: fix.details });

      } else if (fix.action === 'update_description') {
        const all = await getProducts();
        const targets = fix.target === 'all' ? all : all.filter(p => String(p.id) === String(fix.target));
        for (const p of targets) {
          const res = await fetch(`${base}/products/${p.id}.json`, {
            method: 'PUT', headers,
            body: JSON.stringify({ product: { id: p.id, body_html: fix.details } }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`Shopify ${res.status}`);
        }
        applied.push({ action: fix.action, status: 'applied', count: targets.length });

      } else if (fix.action === 'update_seo') {
        const all = await getProducts();
        const targets = fix.target === 'all' ? all : all.filter(p => String(p.id) === String(fix.target));
        for (const p of targets) {
          const seo = typeof fix.details === 'string' ? { title: fix.details } : fix.details;
          const metafields = [];
          if (seo.title) metafields.push({ namespace: 'global', key: 'title_tag', value: seo.title, type: 'single_line_text_field' });
          if (seo.description) metafields.push({ namespace: 'global', key: 'description_tag', value: seo.description, type: 'single_line_text_field' });
          if (metafields.length) {
            const res = await fetch(`${base}/products/${p.id}.json`, {
              method: 'PUT', headers,
              body: JSON.stringify({ product: { id: p.id, metafields } }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) throw new Error(`Shopify ${res.status}`);
          }
        }
        applied.push({ action: fix.action, status: 'applied', count: targets.length });

      } else if (fix.action === 'update_price') {
        const all = await getProducts();
        const targets = fix.target === 'all' ? all : all.filter(p => String(p.id) === String(fix.target));
        for (const p of targets) {
          const price = typeof fix.details === 'object' ? fix.details : { price: fix.details };
          const variants = (p.variants || []).map(v => ({
            id: v.id,
            price: String(price.price || v.price),
            ...(price.compare_at ? { compare_at_price: String(price.compare_at) } : {}),
          }));
          const res = await fetch(`${base}/products/${p.id}.json`, {
            method: 'PUT', headers,
            body: JSON.stringify({ product: { id: p.id, variants } }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`Shopify ${res.status}`);
        }
        applied.push({ action: fix.action, status: 'applied', count: targets.length });

      } else if (fix.action === 'update_images_alt') {
        const all = await getProducts();
        const targets = fix.target === 'all' ? all : all.filter(p => String(p.id) === String(fix.target));
        for (const p of targets) {
          for (const img of (p.images || [])) {
            if (!img.alt || img.alt.trim() === '') {
              const alt = `${p.title} — ${p.product_type || 'product'} by eyeoverthink`;
              await fetch(`${base}/products/${p.id}/images/${img.id}.json`, {
                method: 'PUT', headers,
                body: JSON.stringify({ image: { id: img.id, alt } }),
                signal: AbortSignal.timeout(10_000),
              });
            }
          }
        }
        applied.push({ action: fix.action, status: 'applied', count: targets.length });

      } else {
        applied.push({ action: fix.action, status: 'skipped', reason: `Unknown action: ${fix.action}` });
      }
    } catch (e) {
      applied.push({ action: fix.action, status: 'error', error: e.message });
    }
  }

  return { applied };
}

// ── Full Mystery Shopper Pipeline ─────────────────────────────────
export async function runMysteryShopperPipeline(input = {}, opts = {}) {
  const t0 = Date.now();
  const stages = {};
  const { intel } = opts;

  try {
    // Recall past audit insights
    let priorInsights = [];
    if (intel) {
      try {
        priorInsights = await intel.recallInsights('mystery shopper store audit', 3);
        if (priorInsights.length) stages.intel_recall = { count: priorInsights.length };
      } catch (_) {}
    }

    const t1 = Date.now();
    const shopper = await runShopperAgent(input);
    stages.shopper = { status: 'ok', data: shopper, durationMs: Date.now() - t1 };

    // Emotion-analyze the shopper's first impression
    if (intel && shopper.first_impression) {
      try {
        const emotion = intel.analyzeContent(shopper.first_impression.notes || '');
        if (emotion) stages.intel_emotion = { primary: emotion.primary, sentiment: emotion.sentiment };
      } catch (_) {}
    }

    const [ux, pricing] = await Promise.all([
      runUxAuditor(shopper, input),
      runPriceAnalyst(shopper, input),
    ]);
    stages.ux_auditor = { status: 'ok', data: ux, durationMs: Date.now() - t1 };
    stages.price_analyst = { status: 'ok', data: pricing, durationMs: Date.now() - t1 };

    const t4 = Date.now();
    const report = await runReportAndFix(shopper, ux, pricing, opts);
    stages.report = { status: 'ok', data: report, durationMs: Date.now() - t4 };

    // Store audit results as intelligence insight
    if (intel) {
      intel.storeInsight({
        type: 'mystery_shopper',
        overallGrade: report.overall_store_grade,
        scores: report.scores,
        automatedFixes: report.automated_fixes?.length || 0,
        emotion: stages.intel_emotion || null,
        priorMemories: priorInsights.length,
        durationMs: Date.now() - t0,
      });
    }

    return {
      status: 'success',
      runId: report.runId,
      stages,
      totalDurationMs: Date.now() - t0,
      overallGrade: report.overall_store_grade,
    };
  } catch (e) {
    return { status: 'error', error: e.message, stages, totalDurationMs: Date.now() - t0 };
  }
}
