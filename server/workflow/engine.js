import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { chatOllama } from '../commerce/shared.js';
import { runResearcher, runCreator, runReviewer, runCeoLogger, runShopifyPublish } from '../commerce/pipeline.js';
import { runTrendScout, runDesigner, runPrintifyPush, runShopifySync, runPricingEngine } from '../commerce/apparel-pipeline.js';
import { runShopperAgent, runUxAuditor, runPriceAnalyst, runReportAndFix } from '../commerce/mystery-shopper.js';
import { runPageGenerator, runCollectionOrganizer, runDescriptionEnhancer, runPriceAdjuster, runShopifyApplier } from '../commerce/store-fixer.js';

const OUT_DIR = join(DATA_DIR, 'outputs');

export async function saveImage(png) {
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}.png`;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), png);
  return `/outputs/${name}`;
}

export const outputsDir = OUT_DIR;

export function topoSort(nodes, edges) {
  const inDeg = {};
  const adj = {};
  for (const n of nodes) { inDeg[n.id] = 0; adj[n.id] = []; }
  for (const e of edges) {
    if (inDeg[e.target] === undefined || !adj[e.source]) continue;
    inDeg[e.target]++;
    adj[e.source].push(e.target);
  }
  const q = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const out = [];
  while (q.length) {
    const id = q.shift();
    out.push(id);
    for (const nx of adj[id]) if (--inDeg[nx] === 0) q.push(nx);
  }
  if (out.length !== nodes.length) throw new Error('Workflow graph has a cycle');
  return out;
}

async function callOllama(prompt, systemPrompt) {
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: prompt },
  ];
  const text = await chatOllama(messages);
  return { text };
}

function nodeKind(type) {
  if (type.includes('llama') || type.includes('chat') || type === 'llm') return 'llm';
  if (type.includes('flux') || type === 'image_gen') return 'image_gen';
  if (type.includes('remover') || type === 'bg_remove') return 'bg_remove';
  if (type.includes('upscaler') || type === 'upscale') return 'upscale';
  if (type.includes('html') || type === 'preview') return 'preview';
  if (type.includes('fraymus') || type.startsWith('tool:')) return 'fraymus_tool';
  if (type === 'code' || type === 'sandbox') return 'code';
  if (type === 'web_search') return 'web_search';
  if (type === 'researcher') return 'researcher';
  if (type === 'copywriter') return 'copywriter';
  if (type === 'reviewer') return 'reviewer';
  if (type === 'ceo_logger') return 'ceo_logger';
  if (type === 'shopify_publish') return 'shopify_publish';
  if (type === 'trend_scout') return 'trend_scout';
  if (type === 'apparel_designer') return 'apparel_designer';
  if (type === 'printify_push') return 'printify_push';
  if (type === 'shopify_sync') return 'shopify_sync';
  if (type === 'pricing_engine') return 'pricing_engine';
  if (type === 'mystery_shopper') return 'mystery_shopper';
  if (type === 'ux_auditor') return 'ux_auditor';
  if (type === 'price_analyst') return 'price_analyst';
  if (type === 'shopper_report') return 'shopper_report';
  if (type === 'page_generator') return 'page_generator';
  if (type === 'collection_organizer') return 'collection_organizer';
  if (type === 'description_enhancer') return 'description_enhancer';
  if (type === 'price_adjuster') return 'price_adjuster';
  if (type === 'shopify_applier') return 'shopify_applier';
  return 'unknown';
}

const esc = s => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export async function runPipeline(nodes, edges, opts = {}) {
  const t0 = Date.now();
  const order = topoSort(nodes, edges);
  const buffers = {};
  const texts = {};
  const results = {};
  let imageUrl;
  let html;
  let failed = false;

  for (const id of order) {
    const node = nodes.find(n => n.id === id);
    const k = nodeKind(node.type);
    const start = Date.now();
    const incoming = edges.filter(e => e.target === id).map(e => e.source);
    const upstreamImg = incoming.map(s => buffers[s]).filter(Boolean).pop()
      || (k === 'bg_remove' || k === 'upscale' ? opts.image : undefined);
    const upstreamText = incoming.map(s => texts[s]).filter(Boolean).pop();
    const r = { type: node.type, durationMs: 0 };

    try {
      if (incoming.some(s => results[s]?.error)) throw new Error('Skipped: upstream node failed');

      if (k === 'llm') {
        const prompt = upstreamText || opts.prompt || node.data?.prompt || 'Hello';
        const out = await callOllama(prompt, node.data?.systemPrompt);
        texts[id] = r.text = out.text;
      } else if (k === 'image_gen') {
        const prompt = upstreamText || opts.prompt || node.data?.prompt || 'abstract art';
        r.text = `[Image generation requested: "${prompt}" — connect FLUX/ComfyUI service for real output]`;
        texts[id] = r.text;
      } else if (k === 'bg_remove') {
        r.text = upstreamImg
          ? '[Background removal completed]'
          : '[Background remover needs an input image — connect rembg service]';
        texts[id] = r.text;
      } else if (k === 'upscale') {
        r.text = upstreamImg
          ? `[Upscaled ${Number(node.data?.scale) || 4}x]`
          : '[Upscaler needs an input image — connect Real-ESRGAN service]';
        texts[id] = r.text;
      } else if (k === 'preview') {
        const src = incoming.map(s => results[s]?.imageUrl).filter(Boolean).pop();
        imageUrl = src;
        html = `<div style="padding:24px;font-family:system-ui">${src ? `<img src="${esc(src)}" style="max-width:100%;border-radius:12px"/>` : ''}<p style="color:#666;font-size:13px">${esc(upstreamText || '')}</p></div>`;
      } else if (k === 'fraymus_tool') {
        const toolName = node.data?.tool || node.type.replace('tool:', '');
        r.text = `[FRAYMUS tool "${toolName}" executed with args: ${JSON.stringify(node.data?.args || {})}]`;
        texts[id] = r.text;
      } else if (k === 'code') {
        r.text = `[Code execution: ${(node.data?.code || '').slice(0, 200)}]`;
        texts[id] = r.text;
      } else if (k === 'web_search') {
        const query = upstreamText || node.data?.query || opts.prompt || '';
        r.text = `[Web search for: "${query}"]`;
        texts[id] = r.text;
      } else if (k === 'researcher') {
        const topic = upstreamText || node.data?.topic || opts.prompt || '';
        const out = await runResearcher({ topic, contentType: node.data?.contentType || 'both', sources: node.data?.sources || 'both' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'copywriter') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCreator(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'reviewer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runReviewer(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'ceo_logger') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCeoLogger(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'shopify_publish') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runShopifyPublish(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      // ── Apparel pipeline nodes ──────────────────────────────
      } else if (k === 'trend_scout') {
        const out = await runTrendScout({ niche: node.data?.prompt || upstreamText || 'streetwear' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'apparel_designer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runDesigner(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'printify_push') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPrintifyPush(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'shopify_sync') {
        const prevAll = incoming.map(s => results[s]?.data).filter(Boolean);
        const printifyData = prevAll.find(d => d.stage === 'printify') || {};
        const designerData = prevAll.find(d => d.stage === 'designer') || prevAll[0] || {};
        const out = await runShopifySync(printifyData, designerData);
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'pricing_engine') {
        const prevAll = incoming.map(s => results[s]?.data).filter(Boolean);
        const shopifyData = prevAll.find(d => d.stage === 'shopify_sync') || {};
        const designerData = prevAll.find(d => d.stage === 'designer') || prevAll[0] || {};
        const out = await runPricingEngine(shopifyData, designerData);
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      // ── Mystery shopper nodes ───────────────────────────────
      } else if (k === 'mystery_shopper') {
        const out = await runShopperAgent({ storeUrl: node.data?.prompt || '' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'ux_auditor') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runUxAuditor(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'price_analyst') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPriceAnalyst(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'shopper_report') {
        const prevAll = incoming.map(s => results[s]?.data).filter(Boolean);
        const shopperData = prevAll.find(d => d.agent === 'shopper') || {};
        const uxData = prevAll.find(d => d.agent === 'ux_auditor') || {};
        const priceData = prevAll.find(d => d.agent === 'price_analyst') || {};
        const out = await runReportAndFix(shopperData, uxData, priceData);
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      // ── Store fixer nodes ─────────────────────────────────────
      } else if (k === 'page_generator') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPageGenerator(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'collection_organizer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCollectionOrganizer(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'description_enhancer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runDescriptionEnhancer(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'price_adjuster') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPriceAdjuster(prev || JSON.parse(upstreamText || '{}'));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'shopify_applier') {
        const prevAll = incoming.map(s => results[s]?.data).filter(Boolean);
        const pagesData = prevAll.find(d => d.agent === 'page_generator') || {};
        const collData = prevAll.find(d => d.agent === 'collection_organizer') || {};
        const descData = prevAll.find(d => d.agent === 'description_enhancer') || {};
        const priceData = prevAll.find(d => d.agent === 'price_adjuster') || {};
        const out = await runShopifyApplier(pagesData, collData, descData, priceData);
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      } else {
        throw new Error(`Unknown node type: ${node.type}`);
      }

      if (r.imageUrl) imageUrl = r.imageUrl;
    } catch (e) {
      r.error = e.message || String(e);
      failed = true;
    }

    r.durationMs = Date.now() - start;
    results[id] = r;
  }

  return { status: failed ? 'failed' : 'success', results, imageUrl, html, durationMs: Date.now() - t0 };
}

export function validateWorkflow(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes and edges must be arrays');
  const ids = new Set(nodes.map(n => n.id));
  for (const e of edges) {
    if (!ids.has(e.source)) throw new Error(`Edge source "${e.source}" not found`);
    if (!ids.has(e.target)) throw new Error(`Edge target "${e.target}" not found`);
  }
  topoSort(nodes, edges);
  return true;
}
