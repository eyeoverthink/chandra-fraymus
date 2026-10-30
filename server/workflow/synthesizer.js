import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { topoSort, validateWorkflow } from './engine.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

const NODE_CATALOG = [
  { type: 'llm', desc: 'General LLM text generation via Ollama' },
  { type: 'image_gen', desc: 'Generate images via FLUX.1 (local)' },
  { type: 'bg_remove', desc: 'Remove background from images (BiRefNet)' },
  { type: 'upscale', desc: 'Upscale images (Real-ESRGAN or Sharp Lanczos fallback)' },
  { type: 'image_resize', desc: 'Resize image to specific dimensions (Sharp)' },
  { type: 'image_crop', desc: 'Crop region from image (Sharp)' },
  { type: 'image_convert', desc: 'Convert image format: png/jpeg/webp/avif (Sharp)' },
  { type: 'image_effects', desc: 'Apply effects: blur, sharpen, grayscale, rotate, flip (Sharp)' },
  { type: 'image_watermark', desc: 'Add text watermark overlay to image (Sharp)' },
  { type: 'image_thumbnail', desc: 'Generate square thumbnail from image (Sharp)' },
  { type: 'preview', desc: 'Render HTML preview from text' },
  { type: 'code', desc: 'Execute code in sandbox' },
  { type: 'web_search', desc: 'Search the web via DuckDuckGo' },
  { type: 'fraymus_tool', desc: 'Run a FRAYMUS intelligence tool' },
  { type: 'researcher', desc: 'Commerce: research a topic for product content' },
  { type: 'copywriter', desc: 'Commerce: write product copy from research' },
  { type: 'reviewer', desc: 'Commerce: review and score product content' },
  { type: 'ceo_logger', desc: 'Commerce: log pipeline decision for CEO review' },
  { type: 'shopify_publish', desc: 'Commerce: publish product to Shopify' },
  { type: 'trend_scout', desc: 'Apparel: scout fashion trends for a niche' },
  { type: 'apparel_designer', desc: 'Apparel: design product from trend data' },
  { type: 'printify_push', desc: 'Apparel: push design to Printify' },
  { type: 'shopify_sync', desc: 'Apparel: sync Printify product to Shopify' },
  { type: 'pricing_engine', desc: 'Apparel: set pricing strategy' },
  { type: 'mystery_shopper', desc: 'Audit: run mystery shopper on Shopify store' },
  { type: 'ux_auditor', desc: 'Audit: audit UX of store pages' },
  { type: 'price_analyst', desc: 'Audit: analyze store pricing competitiveness' },
  { type: 'shopper_report', desc: 'Audit: generate shopper report with fixes' },
  { type: 'page_generator', desc: 'Fixer: generate store pages' },
  { type: 'collection_organizer', desc: 'Fixer: organize collections' },
  { type: 'description_enhancer', desc: 'Fixer: enhance product descriptions' },
  { type: 'price_adjuster', desc: 'Fixer: adjust pricing' },
  { type: 'shopify_applier', desc: 'Fixer: apply bulk changes to Shopify' },
  { type: 'heart_feel', desc: 'Intelligence: analyze emotional content' },
  { type: 'dream', desc: 'Intelligence: generate a signed dream' },
  { type: 'consciousness_prove', desc: 'Intelligence: run consciousness proofs' },
  { type: 'cognition', desc: 'Intelligence: two-speed cognition pipeline' },
  { type: 'memory_recall', desc: 'Intelligence: recall from Vertiso memory' },
  { type: 'intelligence_cycle', desc: 'Intelligence: full cycle (heart+cognition+consciousness+dream)' },
];

const VALID_TYPES = new Set(NODE_CATALOG.map(n => n.type));

const SYNTH_PROMPT = `You are a workflow architect. Given a goal, design a visual workflow (DAG) by selecting from available node types and wiring them together.

Available node types:
${NODE_CATALOG.map(n => `- ${n.type}: ${n.desc}`).join('\n')}

Rules:
- Each node needs: id (unique string like "n1", "n2"), type (from the list above), data (object with config, at minimum {label: "short description"})
- Edges connect source node to target node: {source: "n1", target: "n2"}
- The workflow must be a valid DAG (no cycles)
- Use 2-8 nodes. Keep it focused.
- name: a short descriptive name for this workflow

Output ONLY valid JSON: {"name": "...", "nodes": [...], "edges": [...]}
No markdown fences, no explanation.`;

function parseSynthResponse(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in LLM response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateSynthesized(wf) {
  if (!wf.name || typeof wf.name !== 'string') throw new Error('Missing workflow name');
  if (!Array.isArray(wf.nodes) || wf.nodes.length < 1) throw new Error('Need at least 1 node');
  if (wf.nodes.length > 50) throw new Error('Too many nodes (max 50)');
  if (!Array.isArray(wf.edges)) wf.edges = [];

  for (const node of wf.nodes) {
    if (!node.id || !node.type) throw new Error(`Node missing id or type: ${JSON.stringify(node)}`);
    if (!VALID_TYPES.has(node.type)) throw new Error(`Unknown node type: ${node.type}`);
    if (!node.data) node.data = { label: node.type };
  }

  validateWorkflow(wf.nodes, wf.edges);
  return wf;
}

export async function synthesizeWorkflow(goal, { constraints, synthesizedBy = 'system' } = {}) {
  if (!goal || typeof goal !== 'string') throw new Error('goal is required');

  const prompt = constraints
    ? `Goal: ${goal}\n\nConstraints: ${constraints}`
    : `Goal: ${goal}`;

  const response = await chatOllama([
    { role: 'system', content: SYNTH_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const wf = validateSynthesized(parseSynthResponse(response));

  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO workflows (id, user_id, name, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'local', wf.name, JSON.stringify(wf.nodes), JSON.stringify(wf.edges), t, t);

  db.prepare(
    `INSERT INTO synthesized_workflows (workflow_id, synthesized_by, goal, node_count, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, synthesizedBy, goal, wf.nodes.length, t);

  try {
    publish('system', 'system.evolution', JSON.stringify({
      action: 'workflow_synthesized',
      workflowId: id,
      name: wf.name,
      nodeCount: wf.nodes.length,
      goal,
      synthesizedBy,
      at: t,
    }));
  } catch (_) {}

  return {
    synthesized: true,
    workflow: { id, name: wf.name, nodeCount: wf.nodes.length, nodes: wf.nodes, edges: wf.edges },
  };
}

export function listSynthesizedWorkflows() {
  return db.prepare(
    `SELECT sw.*, w.name as workflow_name FROM synthesized_workflows sw
     LEFT JOIN workflows w ON sw.workflow_id = w.id
     ORDER BY sw.created_at DESC`
  ).all();
}

export function installSynthesisRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/workflows/synthesize', route(async (req, res) => {
    const { goal, constraints } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal required' });
    const result = await synthesizeWorkflow(goal, { constraints, synthesizedBy: 'api' });
    res.status(201).json(result);
  }));

  app.get('/api/workflows/synthesized', route((_req, res) => {
    res.json({ synthesized: listSynthesizedWorkflows() });
  }));
}

export { NODE_CATALOG, VALID_TYPES };
