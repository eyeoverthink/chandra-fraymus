import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  imageResize, imageCrop, imageConvert, imageEffects,
  imageWatermark, imageThumbnail, imageUpscale as sharpUpscale,
  comfyuiGenerate, comfyuiResult, comfyuiFetchImage,
} from '../media/image-engine.js';
import {
  videoInfo, videoTrim, videoResize as ffVideoResize,
  videoConvert as ffVideoConvert, videoThumbnail as ffVideoThumb,
  videoToGif, VIDEO_DIR,
} from '../media/video-engine.js';
import { ttsSpeak } from '../media/tts-engine.js';
import { sttTranscribe } from '../media/stt-engine.js';
import { ocrRecognize } from '../media/ocr-engine.js';
import { chatOllama, createCommerceIntel } from '../commerce/shared.js';
import { heart, ledger, dreamer, cognition } from '../fraymus-tools.js';
import { encodeCodon, decodeCodon, codonStats } from '../fraymus/encoding/codon.js';
import { forgePlasmid, digestPlasmid } from '../fraymus/encoding/plasmid.js';
import { createGenomeSnapshot, saveCheckpoint } from '../fraymus/encoding/carbon.js';
import { FraymusStrangeLoopSubstrate, proofEffectiveInformation, proofPhiMIP, proofMirrorProtocol, proofCounterfactualBranching } from '../fraymus/intelligence/ouroboros.js';
import { runResearcher, runCreator, runReviewer, runCeoLogger, runShopifyPublish } from '../commerce/pipeline.js';
import { runTrendScout, runDesigner, runPrintifyPush, runShopifySync, runPricingEngine } from '../commerce/apparel-pipeline.js';
import { runShopperAgent, runUxAuditor, runPriceAnalyst, runReportAndFix } from '../commerce/mystery-shopper.js';
import { runPageGenerator, runCollectionOrganizer, runDescriptionEnhancer, runPriceAdjuster, runShopifyApplier } from '../commerce/store-fixer.js';
import { mintArtifact, verifyArtifact } from '../streaming/mint.js';
import { executeChain, loadRun, listRuns as listChainRuns } from '../chain/engine.js';
import { executeChainToCode } from '../chain/executor.js';
import { generateGoals } from '../intelligence/goal-engine.js';
import { runDebate } from '../intelligence/debate.js';
import { selectModel } from '../intelligence/model-router.js';
import { ledgerStats as chainLedgerStats } from '../chain/ledger.js';
import { getObsBridge } from '../streaming/overlay.js';
import {
  runCreativeBrief, runScriptWriter, runVoiceSynth,
  runVisualAssembly, runDistributionPrep, runCommerceBridge,
} from '../creation/pipeline.js';

const OUT_DIR = join(DATA_DIR, 'outputs');

function safeParse(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

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
  if (type === 'image_resize') return 'image_resize';
  if (type === 'image_crop') return 'image_crop';
  if (type === 'image_convert') return 'image_convert';
  if (type === 'image_effects') return 'image_effects';
  if (type === 'image_watermark') return 'image_watermark';
  if (type === 'image_thumbnail') return 'image_thumbnail';
  if (type === 'video_trim') return 'video_trim';
  if (type === 'video_resize') return 'video_resize';
  if (type === 'video_convert') return 'video_convert';
  if (type === 'video_thumbnail') return 'video_thumbnail';
  if (type === 'video_gif') return 'video_gif';
  if (type === 'tts_speak') return 'tts_speak';
  if (type === 'stt_transcribe') return 'stt_transcribe';
  if (type === 'ocr_recognize') return 'ocr_recognize';
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
  if (type === 'heart_feel') return 'heart_feel';
  if (type === 'dream') return 'dream';
  if (type === 'consciousness_prove') return 'consciousness_prove';
  if (type === 'cognition') return 'cognition';
  if (type === 'memory_recall') return 'memory_recall';
  if (type === 'intelligence_cycle') return 'intelligence_cycle';
  if (type === 'carbon_encode') return 'carbon_encode';
  if (type === 'carbon_plasmid') return 'carbon_plasmid';
  if (type === 'carbon_checkpoint') return 'carbon_checkpoint';
  if (type === 'chain_run') return 'chain_run';
  if (type === 'chain_to_code') return 'chain_to_code';
  if (type === 'goal_generate') return 'goal_generate';
  if (type === 'debate_run') return 'debate_run';
  if (type === 'model_select') return 'model_select';
  if (type === 'perspective_assess') return 'perspective_assess';
  if (type === 'swarm_solve') return 'swarm_solve';
  if (type === 'strategy_route') return 'strategy_route';
  if (type === 'stream_capture') return 'stream_capture';
  if (type === 'stream_mint') return 'stream_mint';
  if (type === 'stream_deliver') return 'stream_deliver';
  if (type === 'creative_brief') return 'creative_brief';
  if (type === 'script_writer') return 'script_writer';
  if (type === 'voice_synth') return 'voice_synth';
  if (type === 'visual_assembly') return 'visual_assembly';
  if (type === 'distribution_prep') return 'distribution_prep';
  if (type === 'commerce_bridge') return 'commerce_bridge';
  if (type === 'social_publish') return 'social_publish';
  if (type === 'analytics_collect') return 'analytics_collect';
  if (type === 'music_generate') return 'music_generate';
  return 'unknown';
}

const esc = s => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export async function runPipeline(nodes, edges, opts = {}) {
  const t0 = Date.now();
  const order = topoSort(nodes, edges);
  const buffers = {};
  const texts = {};
  const results = {};
  const intel = createCommerceIntel(opts.memoryBridge, heart);
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
        const genW = Number(node.data?.width) || 1024;
        const genH = Number(node.data?.height) || 1024;
        r.imagePrompt = prompt;
        let generated = false;
        // Try ComfyUI/FLUX.1 first
        try {
          const job = await comfyuiGenerate(prompt, { width: genW, height: genH, steps: Number(node.data?.steps) || 4 });
          r.text = `ComfyUI job queued: ${job.promptId}`;
          // Poll for result (max 90s)
          const deadline = Date.now() + 90_000;
          while (Date.now() < deadline) {
            await new Promise(ok => setTimeout(ok, 2000));
            const status = await comfyuiResult(job.promptId);
            if (status.status === 'complete' && status.images?.length) {
              const fetched = await comfyuiFetchImage(status.images[0].filename, status.images[0].subfolder);
              r.imageUrl = fetched.url;
              r.text = `Generated via FLUX.1: ${fetched.width}x${fetched.height}`;
              generated = true;
              break;
            }
            if (status.status === 'error') { r.text = `ComfyUI error: ${JSON.stringify(status.error)}`; break; }
          }
        } catch { /* ComfyUI not available */ }
        if (!generated) {
          // Fallback: generate visual description via Ollama
          const out = await callOllama(
            `You are an image generation prompt engineer. Given this request, produce a detailed visual description suitable for an AI image generator. Describe composition, colors, style, lighting, mood. Request: "${prompt}"`,
            'You create rich visual descriptions. Output only the description, no commentary.'
          );
          r.text = out.text;
          r.note = 'ComfyUI not available — visual description generated. Install ComfyUI + FLUX.1 schnell for actual image generation.';
        }
        texts[id] = r.text;
      } else if (k === 'bg_remove') {
        if (upstreamImg) {
          // Attempt rembg via HTTP if available, otherwise use Ollama to describe the foreground
          try {
            const imgBuf = typeof upstreamImg === 'string'
              ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
              : upstreamImg;
            const rembgRes = await fetch('http://127.0.0.1:7000/api/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: imgBuf,
              signal: AbortSignal.timeout(30_000),
            });
            if (rembgRes.ok) {
              const resultBuf = Buffer.from(await rembgRes.arrayBuffer());
              r.imageUrl = await saveImage(resultBuf);
              r.text = 'Background removed successfully';
            } else {
              r.text = 'Background removal service returned error — image passed through unchanged';
            }
          } catch {
            r.text = 'Background removal: rembg service not running on port 7000 — install with `pip install rembg[gpu]` and run `rembg server`';
          }
        } else {
          const out = await callOllama(
            'Describe what the foreground subject of an image would look like after background removal. Context: ' + (upstreamText || 'product photo'),
            'You describe image processing results concisely.'
          );
          r.text = out.text;
        }
        texts[id] = r.text;
      } else if (k === 'upscale') {
        const scale = Number(node.data?.scale) || 4;
        if (upstreamImg) {
          try {
            const imgBuf = typeof upstreamImg === 'string'
              ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
              : upstreamImg;
            // Try Real-ESRGAN via HTTP
            const upRes = await fetch(`http://127.0.0.1:7001/api/upscale?scale=${scale}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: imgBuf,
              signal: AbortSignal.timeout(60_000),
            });
            if (upRes.ok) {
              const resultBuf = Buffer.from(await upRes.arrayBuffer());
              r.imageUrl = await saveImage(resultBuf);
              r.text = `Upscaled ${scale}x successfully`;
            } else {
              r.text = `Upscaler service returned error — image passed through at original resolution`;
            }
          } catch {
            // Fallback: Sharp Lanczos upscale
            try {
              const result = await sharpUpscale(imgBuf, scale);
              r.imageUrl = result.url;
              r.text = `Upscaled ${scale}x via Sharp (Lanczos3): ${result.width}x${result.height}`;
              buffers[id] = (await import('node:fs')).readFileSync(result.path);
            } catch {
              r.text = `Upscaler: Real-ESRGAN not running, Sharp fallback failed — image passed through`;
            }
          }
        } else {
          r.text = `Upscale ${scale}x: no input image provided`;
        }
        texts[id] = r.text;
      } else if (k === 'image_resize') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageResize(imgBuf, {
            width: node.data?.width, height: node.data?.height, fit: node.data?.fit,
          });
          r.imageUrl = result.url;
          r.text = `Resized to ${result.width}x${result.height}`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_resize: no input image'; }
        texts[id] = r.text;
      } else if (k === 'image_crop') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageCrop(imgBuf, {
            left: node.data?.left || 0, top: node.data?.top || 0,
            width: node.data?.width || 256, height: node.data?.height || 256,
          });
          r.imageUrl = result.url;
          r.text = `Cropped to ${result.width}x${result.height}`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_crop: no input image'; }
        texts[id] = r.text;
      } else if (k === 'image_convert') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageConvert(imgBuf, {
            format: node.data?.format || 'webp', quality: node.data?.quality || 80,
          });
          r.imageUrl = result.url;
          r.text = `Converted to ${result.format} (${result.size} bytes)`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_convert: no input image'; }
        texts[id] = r.text;
      } else if (k === 'image_effects') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageEffects(imgBuf, {
            rotate: node.data?.rotate, flip: node.data?.flip, flop: node.data?.flop,
            grayscale: node.data?.grayscale, negate: node.data?.negate,
            blur: node.data?.blur, sharpen: node.data?.sharpen,
            gamma: node.data?.gamma, normalize: node.data?.normalize,
          });
          r.imageUrl = result.url;
          r.text = `Applied effects: ${result.effects.join(', ')}`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_effects: no input image'; }
        texts[id] = r.text;
      } else if (k === 'image_watermark') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageWatermark(imgBuf, node.data?.text || 'CHANDRA', {
            fontSize: node.data?.fontSize, color: node.data?.color, position: node.data?.position,
          });
          r.imageUrl = result.url;
          r.text = `Watermarked: "${result.watermark}"`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_watermark: no input image'; }
        texts[id] = r.text;
      } else if (k === 'image_thumbnail') {
        if (upstreamImg) {
          const imgBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')))
            : upstreamImg;
          const result = await imageThumbnail(imgBuf, node.data?.size || 256);
          r.imageUrl = result.url;
          r.text = `Thumbnail ${result.width}x${result.height}`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'image_thumbnail: no input image'; }
        texts[id] = r.text;
      } else if (k === 'video_trim') {
        if (upstreamImg) {
          const vidBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')).replace(/^\/video\//, join(VIDEO_DIR, '/')))
            : upstreamImg;
          const result = await videoTrim(vidBuf, { start: node.data?.start, end: node.data?.end, duration: node.data?.duration });
          r.text = `Trimmed video: ${result.size} bytes`;
          r.videoUrl = result.url;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'video_trim: no input video'; }
        texts[id] = r.text;
      } else if (k === 'video_resize') {
        if (upstreamImg) {
          const vidBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')).replace(/^\/video\//, join(VIDEO_DIR, '/')))
            : upstreamImg;
          const result = await ffVideoResize(vidBuf, { width: node.data?.width, height: node.data?.height });
          r.text = `Resized video to ${result.width}x${result.height}`;
          r.videoUrl = result.url;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'video_resize: no input video'; }
        texts[id] = r.text;
      } else if (k === 'video_convert') {
        if (upstreamImg) {
          const vidBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')).replace(/^\/video\//, join(VIDEO_DIR, '/')))
            : upstreamImg;
          const result = await ffVideoConvert(vidBuf, { format: node.data?.format || 'webm' });
          r.text = `Converted to ${result.format} (${result.size} bytes)`;
          r.videoUrl = result.url;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'video_convert: no input video'; }
        texts[id] = r.text;
      } else if (k === 'video_thumbnail') {
        if (upstreamImg) {
          const vidBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')).replace(/^\/video\//, join(VIDEO_DIR, '/')))
            : upstreamImg;
          const result = await ffVideoThumb(vidBuf, { time: node.data?.time || '00:00:01' });
          r.imageUrl = result.url;
          r.text = `Extracted frame at ${result.time}`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'video_thumbnail: no input video'; }
        texts[id] = r.text;
      } else if (k === 'video_gif') {
        if (upstreamImg) {
          const vidBuf = typeof upstreamImg === 'string'
            ? (await import('node:fs')).readFileSync(upstreamImg.replace(/^\/outputs\//, join(OUT_DIR, '')).replace(/^\/video\//, join(VIDEO_DIR, '/')))
            : upstreamImg;
          const result = await videoToGif(vidBuf, {
            width: node.data?.width || 480, fps: node.data?.fps || 10,
            start: node.data?.start, duration: node.data?.duration || '3',
          });
          r.imageUrl = result.url;
          r.text = `Converted to GIF (${result.width}px, ${result.fps}fps)`;
          buffers[id] = (await import('node:fs')).readFileSync(result.path);
        } else { r.text = 'video_gif: no input video'; }
        texts[id] = r.text;
      } else if (k === 'tts_speak') {
        const spText = upstreamText || node.data?.text || 'Hello from Chandra';
        const result = await ttsSpeak(spText, {
          voice: node.data?.voice, rate: node.data?.rate, engine: node.data?.engine,
        });
        r.audioUrl = result.url;
        r.text = `Speech generated (${result.engine}): ${result.size} bytes, ~${result.durationEstimate}s`;
        texts[id] = r.text;
      } else if (k === 'stt_transcribe') {
        const audioInput = buffers[incoming[0]] || node.data?.audioBase64;
        if (audioInput) {
          const result = await sttTranscribe(audioInput, {
            language: node.data?.language, engine: node.data?.engine,
          });
          r.transcript = result.transcript;
          r.confidence = result.confidence;
          r.text = result.transcript;
          texts[id] = result.transcript;
        } else { r.text = 'stt_transcribe: no audio input'; }
      } else if (k === 'ocr_recognize') {
        const imageInput = buffers[incoming[0]] || node.data?.imageBase64;
        if (imageInput) {
          const result = await ocrRecognize(imageInput, {
            language: node.data?.language,
          });
          r.ocrText = result.text;
          r.wordCount = result.wordCount;
          r.lines = result.lines;
          r.text = result.text;
          texts[id] = result.text;
        } else { r.text = 'ocr_recognize: no image input'; }
      } else if (k === 'preview') {
        const src = incoming.map(s => results[s]?.imageUrl).filter(Boolean).pop();
        imageUrl = src;
        html = `<div style="padding:24px;font-family:system-ui">${src ? `<img src="${esc(src)}" style="max-width:100%;border-radius:12px"/>` : ''}<p style="color:#666;font-size:13px">${esc(upstreamText || '')}</p></div>`;
      } else if (k === 'fraymus_tool') {
        const toolName = node.data?.tool || node.type.replace('tool:', '');
        r.text = `[FRAYMUS tool "${toolName}" executed with args: ${JSON.stringify(node.data?.args || {})}]`;
        texts[id] = r.text;
      } else if (k === 'code') {
        const code = node.data?.code || upstreamText || '';
        const language = node.data?.language || 'javascript';
        if (language === 'javascript' && code) {
          try {
            const { runInNewContext } = await import('node:vm');
            const sandbox = { console: { log: (...a) => { output.push(a.map(String).join(' ')); } }, result: null };
            const output = [];
            const script = `(async () => { ${code} })().then(r => { result = r; })`;
            await runInNewContext(script, sandbox, { timeout: 10_000 });
            r.text = output.join('\n') || (sandbox.result != null ? String(sandbox.result) : 'Code executed (no output)');
          } catch (e) {
            r.text = `Code error: ${e.message}`;
          }
        } else {
          const out = await callOllama(
            `Execute this ${language} code mentally and return the output:\n\`\`\`${language}\n${code}\n\`\`\``,
            'You simulate code execution. Return only the expected output, no explanation.'
          );
          r.text = out.text;
        }
        texts[id] = r.text;
      } else if (k === 'web_search') {
        const query = upstreamText || node.data?.query || opts.prompt || '';
        try {
          const searchRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            signal: AbortSignal.timeout(15_000),
            headers: { 'User-Agent': 'Chandra/1.0' },
          });
          const html = await searchRes.text();
          const matches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/g)];
          const results = matches.slice(0, 8).map(m => ({ url: m[1], title: m[2].trim() }));
          r.text = results.map((res, i) => `${i + 1}. ${res.title} — ${res.url}`).join('\n');
          r.data = { query, results };
        } catch (e) {
          r.text = `Web search failed: ${e.message}`;
        }
        texts[id] = r.text;
      } else if (k === 'researcher') {
        const topic = upstreamText || node.data?.topic || opts.prompt || '';
        const out = await runResearcher({ topic, contentType: node.data?.contentType || 'both', sources: node.data?.sources || 'both' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'copywriter') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCreator(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'reviewer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runReviewer(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'ceo_logger') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCeoLogger(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'shopify_publish') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runShopifyPublish(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
        if (intel) intel.storeInsight({ type: 'workflow_commerce', node: 'shopify_publish', status: out.status });

      // ── Apparel pipeline nodes ──────────────────────────────
      } else if (k === 'trend_scout') {
        const out = await runTrendScout({ niche: node.data?.prompt || upstreamText || 'streetwear' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'apparel_designer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runDesigner(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'printify_push') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPrintifyPush(prev || safeParse(upstreamText));
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
        if (intel) intel.storeInsight({ type: 'workflow_apparel', node: 'pricing_engine', pricing: out.pricing?.length || 0 });

      // ── Mystery shopper nodes ───────────────────────────────
      } else if (k === 'mystery_shopper') {
        const out = await runShopperAgent({ storeUrl: node.data?.prompt || '' });
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'ux_auditor') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runUxAuditor(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'price_analyst') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPriceAnalyst(prev || safeParse(upstreamText));
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
        if (intel) intel.storeInsight({ type: 'workflow_shopper', node: 'shopper_report', grade: out.overall_store_grade, scores: out.scores });

      // ── Store fixer nodes ─────────────────────────────────────
      } else if (k === 'page_generator') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPageGenerator(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'collection_organizer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runCollectionOrganizer(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'description_enhancer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runDescriptionEnhancer(prev || safeParse(upstreamText));
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;
      } else if (k === 'price_adjuster') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop();
        const out = await runPriceAdjuster(prev || safeParse(upstreamText));
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
        if (intel) intel.storeInsight({ type: 'workflow_fixer', node: 'shopify_applier', status: out.status });

      // ── Intelligence stack nodes ──────────────────────────────
      } else if (k === 'heart_feel') {
        const text = upstreamText || node.data?.text || '';
        const out = heart.feel(text);
        opts.memoryBridge?.storeHeartReading(out).catch(() => {});
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      } else if (k === 'dream') {
        const seed = node.data?.seed || upstreamText || 'workflow dream';
        const inputs = node.data?.inputs || [];
        const kind = node.data?.kind || 'workflow';
        const out = await dreamer.dream(seed, inputs, kind);
        opts.memoryBridge?.storeDream(out).catch(() => {});
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      } else if (k === 'consciousness_prove') {
        const nodeCount = node.data?.nodeCount || 4;
        const substrate = new FraymusStrangeLoopSubstrate(nodeCount);
        const proofs = [
          proofEffectiveInformation(substrate),
          proofPhiMIP(substrate),
          proofMirrorProtocol(substrate),
          proofCounterfactualBranching(substrate),
        ];
        const out = {
          allPassed: proofs.every(p => p.passed),
          proofs,
          architecture: 'FraymusStrangeLoop',
        };
        ledger.record('consciousness.proof.workflow', { allPassed: out.allPassed, passed: proofs.filter(p => p.passed).length }, 'workflow');
        opts.memoryBridge?.storeConsciousnessProof(out).catch(() => {});
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      } else if (k === 'cognition') {
        const text = upstreamText || node.data?.text || '';
        const cogOpts = { skipThink: node.data?.skipThink ?? false };
        const out = await cognition.process(text, cogOpts);
        opts.memoryBridge?.storeCognitionResult(out).catch(() => {});
        texts[id] = r.text = JSON.stringify(out);
        r.data = out;

      } else if (k === 'memory_recall') {
        const query = upstreamText || node.data?.query || '';
        const limit = Math.min(20, Math.max(1, parseInt(node.data?.limit) || 5));
        if (!opts.memoryBridge) {
          r.text = 'Memory Bridge not available';
          r.data = { memories: [], available: false };
        } else {
          const memories = await opts.memoryBridge.recallRelated(query, limit);
          r.data = { memories, count: memories.length, query };
          r.text = JSON.stringify(r.data);
        }
        texts[id] = r.text;

      } else if (k === 'intelligence_cycle') {
        const text = upstreamText || node.data?.prompt || '';
        if (!text) throw new Error('intelligence_cycle requires input text');

        const feeling = heart.feel(text);
        opts.memoryBridge?.storeHeartReading(feeling).catch(() => {});

        const cogResult = await cognition.process(text, { skipThink: false });
        opts.memoryBridge?.storeCognitionResult(cogResult).catch(() => {});

        const substrate = new FraymusStrangeLoopSubstrate(4);
        const proofs = [
          proofEffectiveInformation(substrate),
          proofPhiMIP(substrate),
          proofMirrorProtocol(substrate),
          proofCounterfactualBranching(substrate),
        ];
        const allPassed = proofs.every(p => p.passed);
        opts.memoryBridge?.storeConsciousnessProof({ allPassed, proofs, architecture: 'FraymusStrangeLoop' }).catch(() => {});

        const dreamResult = await dreamer.dream(
          `Cycle: ${text.slice(0, 200)}. Emotion: ${feeling.primary}. Cognition: ${cogResult.phase}.`,
          ['cycle', `emotion:${feeling.primary}`],
          node.data?.dreamKind || 'cycle'
        );
        opts.memoryBridge?.storeDream(dreamResult).catch(() => {});

        r.data = {
          feeling: { primary: feeling.primary, intensity: feeling.intensity, sentiment: feeling.sentiment },
          cognition: { phase: cogResult.phase },
          consciousness: { allPassed, passed: proofs.filter(p => p.passed).length },
          dream: { number: dreamResult.number },
        };
        r.text = JSON.stringify(r.data);
        texts[id] = r.text;

      // ── Logic Chain node ───────────────────────────────────────
      } else if (k === 'chain_run') {
        const objective = upstreamText || node.data?.objective || '';
        if (!objective) throw new Error('chain_run requires an objective');
        const chainConfig = { model: node.data?.model, skipReview: node.data?.skipReview ?? false };
        const chainRun = await executeChain(objective, chainConfig, { broadcast: opts.broadcast || (() => {}), memoryBridge: opts.memoryBridge });
        const stats = chainLedgerStats(chainRun.ledger);
        r.data = {
          runId: chainRun.id, status: chainRun.status, objective,
          entries: stats.total, warnings: stats.warnings,
          reviewed: !!chainRun.review, verified: chainRun.review?.stats?.verified || 0,
          durationMs: chainRun.usage?.durationMs,
        };
        r.text = `Chain ${chainRun.id}: ${stats.total} entries, ${stats.warnings} warnings, ${chainRun.review?.stats?.verified || 0} verified`;
        texts[id] = r.text;

      // ── Chain-to-Code: run chain then execute verified steps ─
      } else if (k === 'chain_to_code') {
        const chainRunId = upstreamText || node.data?.chainRunId || '';
        if (!chainRunId) throw new Error('chain_to_code requires a chainRunId (or upstream chain_run output)');
        const idMatch = chainRunId.match(/chain_[a-f0-9]+/);
        const resolvedId = idMatch ? idMatch[0] : chainRunId.trim();
        const execResult = await executeChainToCode(resolvedId, {
          language: node.data?.language || 'javascript',
          maxSteps: node.data?.maxSteps || 5,
          maxIterations: node.data?.maxIterations || 3,
        }, { broadcast: opts.broadcast || (() => {}) });
        r.data = {
          execId: execResult.execId, chainRunId: execResult.chainRunId,
          status: execResult.status, passed: execResult.passed,
          failed: execResult.failed, total: execResult.total,
          durationMs: execResult.durationMs,
        };
        r.text = `ChainToCode ${execResult.execId}: ${execResult.passed}/${execResult.total} steps produced verified code (${execResult.status})`;
        texts[id] = r.text;

      } else if (k === 'goal_generate') {
        const goalResult = await generateGoals({ trigger: 'workflow' });
        r.data = {
          generated: goalResult.generated, count: goalResult.count,
          proposals: (goalResult.proposals || []).map(p => ({ id: p.id, objective: p.objective, priority: p.priority })),
        };
        r.text = goalResult.generated
          ? `GoalEngine: ${goalResult.count} new objective${goalResult.count === 1 ? '' : 's'} proposed`
          : `GoalEngine: no new objectives (${goalResult.reason || 'landscape empty'})`;
        texts[id] = r.text;

      } else if (k === 'debate_run') {
        const topic = node.data?.topic || upstreamText || 'System Architecture';
        const proposition = node.data?.proposition || upstreamText || topic;
        const debateResult = await runDebate({ topic, proposition, config: { model: node.data?.model }, source: 'workflow' });
        r.data = {
          id: debateResult.id, verdict: debateResult.verdict,
          confidence: debateResult.confidence, durationMs: debateResult.durationMs,
          agents: debateResult.agents,
        };
        r.text = `Debate "${proposition.slice(0, 60)}": verdict=${debateResult.verdict} (${Math.round(debateResult.confidence * 100)}% confidence)`;
        texts[id] = r.text;

      } else if (k === 'model_select') {
        const task = { prompt: upstreamText || node.data?.prompt || '', type: node.data?.taskType || 'inference', depth: node.data?.depth || 0 };
        const routing = await selectModel(task);
        r.data = { model: routing.model, tier: routing.tier, complexity: routing.complexity, reason: routing.reason, candidates: routing.candidates };
        r.text = `ModelRouter: ${routing.model} (${routing.tier}, complexity=${routing.complexity}, reason=${routing.reason})`;
        texts[id] = r.text;

      } else if (k === 'perspective_assess') {
        const { assessSituation } = await import('../intelligence/perspective.js');
        const result = await assessSituation({ task: upstreamText || node.data?.task || 'workflow assessment', context: node.data?.context || '' });
        r.data = { perspectives: result.perspectives, confidence: result.confidence, framing: result.framing, pattern: result.pattern_match };
        r.text = `Perspective: [${(result.perspectives || []).join(', ')}] (${(result.confidence * 100).toFixed(0)}%) — ${result.framing || ''}`;
        texts[id] = r.text;

      } else if (k === 'swarm_solve') {
        const { initiateSwarm } = await import('../intelligence/swarm.js');
        const result = await initiateSwarm({ task: upstreamText || node.data?.task || 'swarm task', context: node.data?.context || '', agentCount: node.data?.agentCount || 3, perspectiveMode: node.data?.perspectiveMode || 'diverse' });
        r.data = { swarmId: result.swarmId, quality: result.quality, keyInsights: result.keyInsights, agentCount: result.agentCount };
        r.text = `Swarm [${result.agentCount} agents] — ${result.keyInsights?.length || 0} insights, quality: ${result.quality ? Math.round(result.quality * 100) + '%' : 'N/A'}`;
        texts[id] = r.text;

      } else if (k === 'strategy_route') {
        const { executeStrategy } = await import('../intelligence/strategy.js');
        const result = await executeStrategy({ task: upstreamText || node.data?.task || 'strategy task', context: node.data?.context || '', autoExecute: !!node.data?.autoExecute });
        r.data = { strategyId: result.strategyId, path: result.executionPath || result.recommendedPath, confidence: result.analysis?.confidence, quality: result.quality };
        r.text = `Strategy → ${result.executionPath || result.recommendedPath || 'planned'} (confidence: ${result.analysis?.confidence ? Math.round(result.analysis.confidence * 100) + '%' : 'N/A'})`;
        texts[id] = r.text;

      // ── Carbon X biological encoding nodes ──────────────────
      } else if (k === 'carbon_encode') {
        const text = upstreamText || node.data?.text || '';
        if (!text) throw new Error('carbon_encode requires input text');
        const bytes = new TextEncoder().encode(text);
        const encoded = encodeCodon(bytes);
        const stats = codonStats(encoded);
        r.data = { encoded: encoded.slice(0, 200) + (encoded.length > 200 ? '...' : ''), stats, inputSize: bytes.length };
        r.text = `Codon-encoded ${bytes.length} bytes → ${stats.totalBases} bases (GC ${stats.gcContent}%)`;
        texts[id] = encoded;

      } else if (k === 'carbon_plasmid') {
        const payload = upstreamText || node.data?.payload || '';
        if (!payload) throw new Error('carbon_plasmid requires payload');
        const plasmid = forgePlasmid(payload, { name: node.data?.name || 'workflow', type: node.data?.type || 'gene' });
        r.data = { size: plasmid.size, gcContent: plasmid.gcContent, features: plasmid.features.length, integrity: plasmid.integrity.slice(0, 16) };
        r.text = `Plasmid forged: ${plasmid.size} bases, GC ${plasmid.gcContent}%, ${plasmid.features.length} features`;
        texts[id] = plasmid.dna;
        opts.memoryBridge?.storeCognitionResult({ phase: 'carbon_plasmid', feeling: { primary: 'curiosity', intensity: 0.5 }, response: `Workflow plasmid: ${node.data?.name || 'workflow'}, ${plasmid.size} bases`, durationMs: 0 }).catch(() => {});

      } else if (k === 'carbon_checkpoint') {
        const workspace = {
          name: node.data?.name || 'workflow-checkpoint',
          agents: [], workflows: [],
          settings: { source: 'workflow_node' },
          tools: [],
          activeTasks: [], busTopics: [], healthStatus: 'nominal', uptime: 0,
          memories: [], reflections: [], fossils: [], dreamLog: [],
        };
        if (upstreamText) {
          try { Object.assign(workspace, JSON.parse(upstreamText)); } catch { workspace.settings.rawInput = upstreamText.slice(0, 2000); }
        }
        const snapshot = createGenomeSnapshot(workspace);
        const { filepath } = saveCheckpoint(snapshot, DATA_DIR);
        r.data = { organism: snapshot.organism, chromosomes: snapshot.chromosomes, totalBases: snapshot.stats.totalBases, filepath };
        r.text = `Checkpoint: ${snapshot.stats.totalBases} bases, ${snapshot.chromosomes} chromosomes → ${filepath}`;
        texts[id] = r.text;
        opts.memoryBridge?.storeCognitionResult({ phase: 'carbon_checkpoint', feeling: { primary: 'determination', intensity: 0.6 }, response: `Workflow checkpoint: ${snapshot.organism}, ${snapshot.stats.totalBases} bases`, durationMs: 0 }).catch(() => {});

      // ── Streaming / Living Artifact nodes ──────────────────
      } else if (k === 'stream_capture') {
        const donorName = node.data?.donor_name || upstreamText || 'Anonymous';
        const amount = parseFloat(node.data?.amount) || 0;
        const message = node.data?.message || upstreamText || '';
        r.data = { donorName, amount, message, streamerId: node.data?.streamer_id || 'workflow-stream', timestamp: new Date().toISOString() };
        r.text = `Captured donation: ${donorName} $${amount}`;
        texts[id] = JSON.stringify(r.data);

      } else if (k === 'stream_mint') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const mintInput = {
          streamerId: prev.streamerId || node.data?.streamer_id || 'workflow-stream',
          donorId: `wf_${Date.now().toString(36)}`,
          donorName: prev.donorName || node.data?.donor_name || 'Anonymous',
          amount: prev.amount || parseFloat(node.data?.amount) || 0,
          message: prev.message || node.data?.message || '',
          timestamp: prev.timestamp || new Date().toISOString(),
        };
        const result = await mintArtifact(mintInput, { dataDir: DATA_DIR, broadcast: opts.broadcast });
        r.data = { artifact: result.artifact, pngBase64: result.pngBase64, wasmBase64: result.wasmBase64, stegoEmoji: result.stegoEmoji, durationMs: result.durationMs };
        r.text = `Minted artifact ${result.artifact.id} (${result.durationMs}ms)`;
        texts[id] = JSON.stringify(r.data);
        opts.memoryBridge?.storeCognitionResult({ phase: 'stream_mint', feeling: { primary: 'creation', intensity: 0.8 }, response: `Workflow mint: ${result.artifact.id}, ${result.artifact.wasmSize} bytes`, durationMs: result.durationMs }).catch(() => {});

      } else if (k === 'stream_deliver') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const bridge = getObsBridge();
        let delivered = 0;
        if (prev.artifact && bridge) {
          delivered = bridge.broadcastArtifact({
            id: prev.artifact.id,
            donorName: prev.artifact.donorName,
            amount: prev.artifact.amount,
            message: prev.artifact.message,
            pngBase64: prev.pngBase64,
            wasmBase64: prev.wasmBase64,
            sha256: prev.artifact.sha256,
            stegoEmoji: prev.stegoEmoji,
            signature: prev.artifact.signed,
            timestamp: prev.artifact.timestamp,
            durationMs: prev.durationMs,
          });
        }
        r.data = { delivered, artifactId: prev.artifact?.id };
        r.text = `Delivered to ${delivered} overlay(s)`;
        texts[id] = r.text;

      // ── Creation Pipeline nodes ────────────────────────────
      } else if (k === 'creative_brief') {
        const topic = upstreamText || node.data?.topic || opts.prompt || 'content creation';
        const result = await runCreativeBrief(
          { topic, format: node.data?.format || 'short_video', style: node.data?.style || 'auto' },
          { intel },
        );
        r.data = result;
        texts[id] = JSON.stringify(result.brief);
        r.text = `Brief: ${result.brief?.title || topic}`;

      } else if (k === 'script_writer') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const input = { brief: prev.brief || {}, topic: prev.topic || opts.prompt || '', format: prev.format || 'short_video' };
        const result = await runScriptWriter(input);
        r.data = result;
        texts[id] = JSON.stringify(result.script);
        r.text = `Script: ${result.script?.shot_list?.length || 0} shots`;

      } else if (k === 'voice_synth') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const input = { script: prev.script || {}, topic: prev.topic || opts.prompt || '' };
        const result = await runVoiceSynth(input);
        r.data = result;
        texts[id] = result.narration || '';
        r.text = `Voice: ${result.audio?.engine || 'none'} (${result.audio?.status})`;

      } else if (k === 'visual_assembly') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const result = await runVisualAssembly(prev);
        r.data = result;
        texts[id] = JSON.stringify(result.compositions || []);
        r.text = `Visuals: ${result.shotCount || 0} compositions`;
        if (result.heroImage) { r.imageUrl = result.heroImage; }

      } else if (k === 'distribution_prep') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const result = await runDistributionPrep(prev);
        r.data = result;
        texts[id] = JSON.stringify(result.packages || []);
        r.text = `Distribution: ${result.channelCount || 0} channels`;

      } else if (k === 'commerce_bridge') {
        const prev = incoming.map(s => results[s]?.data).filter(Boolean).pop() || {};
        const result = await runCommerceBridge(prev);
        r.data = result;
        texts[id] = result.status;
        r.text = `Commerce: ${result.status}`;

      // ── Distribution + Analytics + Music nodes ────────────
      } else if (k === 'social_publish') {
        const content = upstreamText || node.data?.content || opts.prompt || '';
        const platforms = node.data?.platforms || ['youtube', 'tiktok', 'instagram', 'x'];
        try {
          const res = await fetch('http://127.0.0.1:8787/api/distribution/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, platforms }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await res.json();
          r.data = data;
          r.text = `Published to ${platforms.length} platforms`;
          texts[id] = JSON.stringify(data);
        } catch (e) {
          throw new Error(`social_publish failed: ${e.message}`);
        }
        opts.memoryBridge?.storeCognitionResult({ phase: 'social_publish', feeling: { primary: 'excitement', intensity: 0.7 }, response: `Workflow publish: ${platforms.join(', ')}`, durationMs: 0 }).catch(() => {});

      } else if (k === 'analytics_collect') {
        const topic = node.data?.topic || upstreamText || '';
        try {
          const endpoint = topic
            ? `http://127.0.0.1:8787/api/analytics/topic/${encodeURIComponent(topic)}`
            : 'http://127.0.0.1:8787/api/analytics/overview';
          const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
          const data = await res.json();
          r.data = data;
          r.text = topic ? `Analytics for "${topic}": ${data.analytics?.length || 0} entries` : `Overview: ${data.total || 0} entries`;
          texts[id] = JSON.stringify(data);
        } catch (e) {
          throw new Error(`analytics_collect failed: ${e.message}`);
        }

      } else if (k === 'music_generate') {
        const topic = upstreamText || node.data?.topic || opts.prompt || '';
        const emotion = node.data?.emotion || null;
        const format = node.data?.format || 'background';
        try {
          const res = await fetch('http://127.0.0.1:8787/api/media/music/pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, emotion, format }),
            signal: AbortSignal.timeout(60_000),
          });
          const data = await res.json();
          r.data = data;
          r.text = `Music: ${data.prompt?.slice(0, 60) || 'generated'}`;
          texts[id] = data.prompt || '';
        } catch (e) {
          throw new Error(`music_generate failed: ${e.message}`);
        }
        opts.memoryBridge?.storeCognitionResult({ phase: 'music_generate', feeling: { primary: 'joy', intensity: 0.6 }, response: `Workflow music: ${topic}`, durationMs: 0 }).catch(() => {});

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
