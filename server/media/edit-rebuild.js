// Edit Rebuild Pipeline — Free Katana alternative
// 5-stage DAG: Scene Detect → Shot Plan → Product Place → Image-to-Video → Concat
// Uses: ffmpeg (scene detect + concat), Ollama (planning), ComfyUI/FLUX.1 (placement), Wan/CogVideo (i2v)

import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { DATA_DIR } from '../config.js';
import { chatOllama } from '../commerce/shared.js';
import { comfyuiStatus, comfyuiGenerate } from './image-engine.js';
import { VIDEO_DIR, videoUrl } from './video-engine.js';

const execFileAsync = promisify(execFile);

const REBUILD_DIR = join(DATA_DIR, 'edit-rebuild');
mkdirSync(REBUILD_DIR, { recursive: true });

const COMFYUI_BASE = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

async function runFF(bin, args, timeoutMs = 120_000) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}

function writeTempFile(buf, ext = '.mp4') {
  const name = `chandra-rebuild-${randomBytes(6).toString('hex')}${ext}`;
  const p = join(tmpdir(), name);
  writeFileSync(p, buf);
  return p;
}

function cleanTemp(p) { try { unlinkSync(p); } catch { /* ok */ } }

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string' && input.startsWith('data:')) {
    const m = input.match(/^data:[^;]+;base64,(.+)$/s);
    if (m) return Buffer.from(m[1], 'base64');
  }
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  throw new Error('Invalid input — expected Buffer, base64, or data URI');
}

// ═══════════════════════════════════════════════════════════
// Stage 1: Scene Detection — find cut boundaries via ffmpeg
// ═══════════════════════════════════════════════════════════

export async function detectScenes(videoInput, { threshold = 0.3, minDuration = 0.5 } = {}) {
  const buf = toBuffer(videoInput);
  const tmp = writeTempFile(buf);
  try {
    // Get video duration + info first
    const { stdout: probeOut } = await runFF('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', tmp,
    ]);
    const probeData = JSON.parse(probeOut);
    const duration = parseFloat(probeData.format?.duration) || 0;
    const vs = probeData.streams?.find(s => s.codec_type === 'video');
    const width = vs?.width || 1280;
    const height = vs?.height || 720;
    const fps = vs?.r_frame_rate || '30/1';

    // Run scene detection — outputs timestamps of scene changes
    const { stderr: sceneOut } = await runFF('ffmpeg', [
      '-i', tmp,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null', '-',
    ], 300_000);

    // Parse scene change timestamps from showinfo output
    const sceneRegex = /pts_time:([\d.]+)/g;
    const cutPoints = [0]; // always starts at 0
    let match;
    while ((match = sceneRegex.exec(sceneOut)) !== null) {
      const t = parseFloat(match[1]);
      // Skip cuts too close to the previous one
      if (t - cutPoints[cutPoints.length - 1] >= minDuration) {
        cutPoints.push(t);
      }
    }

    // Build shots array with start/end times
    const shots = [];
    for (let i = 0; i < cutPoints.length; i++) {
      const start = cutPoints[i];
      const end = i + 1 < cutPoints.length ? cutPoints[i + 1] : duration;
      if (end - start < 0.1) continue;
      shots.push({
        index: shots.length,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        duration: Math.round((end - start) * 1000) / 1000,
      });
    }

    // Extract a thumbnail for each shot (first frame)
    const shotDir = join(REBUILD_DIR, `shots-${Date.now()}`);
    mkdirSync(shotDir, { recursive: true });

    for (const shot of shots) {
      const thumbName = `shot-${String(shot.index).padStart(3, '0')}.png`;
      const thumbPath = join(shotDir, thumbName);
      try {
        await runFF('ffmpeg', [
          '-y', '-ss', String(shot.start), '-i', tmp,
          '-frames:v', '1', '-q:v', '2', thumbPath,
        ]);
        shot.thumbnail = thumbPath;
        shot.thumbnailSize = statSync(thumbPath).size;
      } catch {
        shot.thumbnail = null;
      }
    }

    return {
      duration,
      width,
      height,
      fps,
      threshold,
      shotCount: shots.length,
      shots,
      shotDir,
    };
  } finally {
    cleanTemp(tmp);
  }
}

// ═══════════════════════════════════════════════════════════
// Stage 2: Shot Planning — LLM generates prompts per shot
// ═══════════════════════════════════════════════════════════

export async function planShots(sceneData, { productDescription, instruction, model } = {}) {
  if (!productDescription) throw new Error('productDescription required');

  const shotDescriptions = sceneData.shots.map(s =>
    `Shot ${s.index}: ${s.duration}s (${s.start}s → ${s.end}s)`
  ).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are a video production AI. You plan shot-by-shot recreations of reference videos with new products/characters.
For each shot, generate TWO things:
1. An image generation prompt (for placing the product in the first frame)
2. A motion/animation description (for animating that frame into video)

Output valid JSON array. Each element: { "shotIndex": N, "imagePrompt": "...", "motionPrompt": "...", "cameraMove": "pan_left|pan_right|zoom_in|zoom_out|static|tilt_up|tilt_down|dolly_in|tracking" }

Be specific about composition, lighting, and the product placement. The image prompt should describe a photorealistic scene with the product prominently featured.`,
    },
    {
      role: 'user',
      content: `Reference video has ${sceneData.shotCount} shots across ${sceneData.duration}s.

${shotDescriptions}

Product: ${productDescription}
${instruction ? `\nInstruction: ${instruction}` : ''}

Generate the shot plan as a JSON array.`,
    },
  ];

  const response = await chatOllama(messages, { model, temperature: 0.7, maxTokens: 4096 });
  const content = response?.message?.content || response?.content || '';

  // Parse JSON from response
  let shotPlan;
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');
    shotPlan = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // Fallback: generate basic prompts
    shotPlan = sceneData.shots.map(s => ({
      shotIndex: s.index,
      imagePrompt: `Photorealistic product shot of ${productDescription}, professional lighting, high quality`,
      motionPrompt: `Smooth camera movement showing ${productDescription}`,
      cameraMove: 'static',
    }));
  }

  // Ensure every shot has a plan
  const planned = sceneData.shots.map(shot => {
    const plan = shotPlan.find(p => p.shotIndex === shot.index) || shotPlan[shot.index] || {
      shotIndex: shot.index,
      imagePrompt: `Photorealistic product shot of ${productDescription}`,
      motionPrompt: `Smooth reveal of ${productDescription}`,
      cameraMove: 'static',
    };
    return {
      ...shot,
      imagePrompt: plan.imagePrompt,
      motionPrompt: plan.motionPrompt,
      cameraMove: plan.cameraMove || 'static',
    };
  });

  return {
    productDescription,
    instruction: instruction || null,
    shotCount: planned.length,
    shots: planned,
  };
}

// ═══════════════════════════════════════════════════════════
// Stage 3: Product Placement — generate first frame per shot
// via ComfyUI/FLUX.1 (or fallback to reference frame)
// ═══════════════════════════════════════════════════════════

export async function placeProducts(shotPlan, { width = 720, height = 1280, productImage } = {}) {
  const comfyStatus = await comfyuiStatus();
  const results = [];

  for (const shot of shotPlan.shots) {
    if (comfyStatus.available) {
      try {
        const genResult = await comfyuiGenerate(shot.imagePrompt, {
          width,
          height,
          steps: 4,
          cfg: 1,
        });

        // Poll for result (ComfyUI is async)
        let imageReady = false;
        let imageData = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const histRes = await fetch(`${COMFYUI_BASE}/history/${genResult.prompt_id}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!histRes.ok) continue;
            const hist = await histRes.json();
            const entry = hist[genResult.prompt_id];
            if (entry?.outputs) {
              const outputNode = Object.values(entry.outputs).find(o => o.images?.length);
              if (outputNode) {
                const img = outputNode.images[0];
                const imgRes = await fetch(
                  `${COMFYUI_BASE}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=output`,
                  { signal: AbortSignal.timeout(30000) }
                );
                if (imgRes.ok) {
                  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                  const frameName = `placed-${shot.index}-${Date.now()}.png`;
                  const framePath = join(REBUILD_DIR, frameName);
                  writeFileSync(framePath, imgBuf);
                  imageData = { path: framePath, size: imgBuf.length, source: 'comfyui' };
                  imageReady = true;
                }
              }
              break;
            }
          } catch { /* retry */ }
        }

        if (imageReady) {
          results.push({ shotIndex: shot.index, ...imageData, prompt: shot.imagePrompt });
          continue;
        }
      } catch (e) {
        // Fall through to fallback
      }
    }

    // Fallback: use the reference thumbnail if available
    if (shot.thumbnail) {
      results.push({
        shotIndex: shot.index,
        path: shot.thumbnail,
        size: shot.thumbnailSize || 0,
        source: 'reference_frame',
        prompt: shot.imagePrompt,
        note: 'ComfyUI unavailable — using reference frame as placeholder',
      });
    } else {
      results.push({
        shotIndex: shot.index,
        path: null,
        source: 'none',
        prompt: shot.imagePrompt,
        note: 'No image generated — ComfyUI unavailable and no reference frame',
      });
    }
  }

  return {
    shotCount: results.length,
    comfyAvailable: comfyStatus.available,
    frames: results,
  };
}

// ═══════════════════════════════════════════════════════════
// Stage 4: Image-to-Video — animate each placed frame
// via ComfyUI (Wan-Animate/CogVideoX nodes) or fallback
// ═══════════════════════════════════════════════════════════

async function checkI2VModel() {
  try {
    const res = await fetch(`${COMFYUI_BASE}/object_info`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { available: false, model: null };
    const nodes = await res.json();
    // Check for common i2v nodes
    const i2vNodes = ['WanImageToVideo', 'CogVideoImageEncode', 'SVD_img2vid_Conditioning', 'AnimateDiffLoaderV1'];
    for (const nodeName of i2vNodes) {
      if (nodes[nodeName]) {
        return { available: true, model: nodeName };
      }
    }
    return { available: false, model: null, hint: 'Install Wan-Animate or CogVideoX ComfyUI nodes for image-to-video' };
  } catch {
    return { available: false, model: null };
  }
}

export async function animateFrames(placedFrames, shotPlan, { fps = 24, width = 720, height = 1280 } = {}) {
  const i2vStatus = await checkI2VModel();
  const clips = [];

  for (const frame of placedFrames.frames) {
    if (!frame.path) {
      clips.push({ shotIndex: frame.shotIndex, path: null, source: 'skipped', note: 'No frame to animate' });
      continue;
    }

    const shot = shotPlan.shots.find(s => s.index === frame.shotIndex) || {};
    const targetDuration = shot.duration || 2;

    if (i2vStatus.available) {
      try {
        // Build ComfyUI workflow for image-to-video
        const imgBuf = readFileSync(frame.path);
        const imgB64 = imgBuf.toString('base64');

        const i2vWorkflow = buildI2VWorkflow(i2vStatus.model, {
          imageBase64: imgB64,
          prompt: shot.motionPrompt || 'smooth natural motion',
          duration: targetDuration,
          fps,
          width,
          height,
        });

        const queueRes = await fetch(`${COMFYUI_BASE}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: i2vWorkflow }),
          signal: AbortSignal.timeout(15000),
        });

        if (queueRes.ok) {
          const { prompt_id } = await queueRes.json();
          // Poll for completion (i2v can take a while)
          for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              const histRes = await fetch(`${COMFYUI_BASE}/history/${prompt_id}`, {
                signal: AbortSignal.timeout(5000),
              });
              if (!histRes.ok) continue;
              const hist = await histRes.json();
              const entry = hist[prompt_id];
              if (entry?.outputs) {
                const outputNode = Object.values(entry.outputs).find(o => o.gifs?.length || o.videos?.length);
                if (outputNode) {
                  const vid = (outputNode.gifs || outputNode.videos)[0];
                  const vidRes = await fetch(
                    `${COMFYUI_BASE}/view?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder || '')}&type=output`,
                    { signal: AbortSignal.timeout(60000) }
                  );
                  if (vidRes.ok) {
                    const vidBuf = Buffer.from(await vidRes.arrayBuffer());
                    const clipName = `clip-${frame.shotIndex}-${Date.now()}.mp4`;
                    const clipPath = join(REBUILD_DIR, clipName);
                    writeFileSync(clipPath, vidBuf);
                    clips.push({ shotIndex: frame.shotIndex, path: clipPath, size: vidBuf.length, source: 'comfyui_i2v', duration: targetDuration });
                    break;
                  }
                }
                break;
              }
            } catch { /* retry */ }
          }
          if (clips.find(c => c.shotIndex === frame.shotIndex)) continue;
        }
      } catch { /* fall through */ }
    }

    // Fallback: create a Ken Burns style clip from the still frame using ffmpeg
    const clipName = `clip-${frame.shotIndex}-${Date.now()}.mp4`;
    const clipPath = join(REBUILD_DIR, clipName);
    const d = Math.max(targetDuration, 1);

    // Ken Burns: slow zoom from 100% to 110% over the duration
    try {
      await runFF('ffmpeg', [
        '-y', '-loop', '1', '-i', frame.path,
        '-vf', `scale=${width * 2}:${height * 2},zoompan=z='min(zoom+0.0015,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d * fps)}:s=${width}x${height}:fps=${fps}`,
        '-t', String(d),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        clipPath,
      ], 120_000);

      const s = statSync(clipPath);
      clips.push({
        shotIndex: frame.shotIndex,
        path: clipPath,
        size: s.size,
        source: 'ken_burns_fallback',
        duration: d,
        note: i2vStatus.available ? 'I2V generation failed, used Ken Burns' : 'No I2V model — used Ken Burns pan/zoom',
      });
    } catch (e) {
      clips.push({
        shotIndex: frame.shotIndex,
        path: null,
        source: 'failed',
        note: `ffmpeg Ken Burns failed: ${e.message}`,
      });
    }
  }

  return {
    i2vAvailable: i2vStatus.available,
    i2vModel: i2vStatus.model,
    clipCount: clips.filter(c => c.path).length,
    clips,
  };
}

function buildI2VWorkflow(modelNode, { prompt, duration, fps, width, height }) {
  // Generic ComfyUI i2v workflow template — adapts per model
  if (modelNode === 'WanImageToVideo') {
    return {
      "1": { class_type: "WanImageToVideo", inputs: { prompt, negative_prompt: "blurry, distorted, low quality", width, height, num_frames: Math.round(duration * fps), steps: 20, cfg: 6, seed: Math.floor(Math.random() * 2 ** 32) } },
    };
  }
  // Default: basic SVD-style workflow
  return {
    "1": { class_type: modelNode, inputs: { prompt, width, height, video_frames: Math.round(duration * fps), steps: 20, cfg: 2.5, seed: Math.floor(Math.random() * 2 ** 32) } },
  };
}

// ═══════════════════════════════════════════════════════════
// Stage 5: Concat — stitch all clips preserving original order
// ═══════════════════════════════════════════════════════════

export async function concatClips(animatedClips, { format = 'mp4' } = {}) {
  const validClips = animatedClips.clips
    .filter(c => c.path)
    .sort((a, b) => a.shotIndex - b.shotIndex);

  if (validClips.length === 0) {
    throw new Error('No valid clips to concatenate');
  }

  if (validClips.length === 1) {
    // Single clip — just copy it to output
    const buf = readFileSync(validClips[0].path);
    const outName = `rebuild-${Date.now()}-${randomBytes(4).toString('hex')}.${format}`;
    const outPath = join(VIDEO_DIR, outName);
    writeFileSync(outPath, buf);
    return {
      url: videoUrl(outName),
      path: outPath,
      size: buf.length,
      clipCount: 1,
    };
  }

  // Re-encode all clips to the same format/resolution for safe concat
  const normalizedPaths = [];
  const firstClip = validClips[0];

  for (const clip of validClips) {
    const normName = `norm-${clip.shotIndex}-${randomBytes(4).toString('hex')}.ts`;
    const normPath = join(tmpdir(), normName);
    try {
      await runFF('ffmpeg', [
        '-y', '-i', clip.path,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-f', 'mpegts', normPath,
      ], 120_000);
      normalizedPaths.push(normPath);
    } catch {
      normalizedPaths.push(null);
    }
  }

  const validNorm = normalizedPaths.filter(Boolean);
  if (validNorm.length === 0) throw new Error('All clips failed normalization');

  const concatInput = validNorm.map(p => p.replace(/\\/g, '/')).join('|');
  const outName = `rebuild-${Date.now()}-${randomBytes(4).toString('hex')}.${format}`;
  const outPath = join(VIDEO_DIR, outName);

  try {
    await runFF('ffmpeg', [
      '-y', '-i', `concat:${concatInput}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ], 300_000);

    const s = statSync(outPath);
    return {
      url: videoUrl(outName),
      path: outPath,
      size: s.size,
      clipCount: validClips.length,
    };
  } finally {
    normalizedPaths.forEach(p => { if (p) cleanTemp(p); });
  }
}

// ═══════════════════════════════════════════════════════════
// Full Pipeline Orchestrator
// ═══════════════════════════════════════════════════════════

export async function runEditRebuild(videoInput, {
  productDescription,
  productImage,
  instruction,
  threshold = 0.3,
  width = 720,
  height = 1280,
  fps = 24,
  model,
  onProgress,
} = {}) {
  const jobId = `rebuild-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const startTime = Date.now();
  const progress = (stage, detail) => onProgress?.({ jobId, stage, detail, elapsed: Date.now() - startTime });

  // Stage 1: Scene Detection
  progress('scene_detect', 'Analyzing reference video for cuts...');
  const scenes = await detectScenes(videoInput, { threshold });
  progress('scene_detect', `Found ${scenes.shotCount} shots across ${scenes.duration}s`);

  // Stage 2: Shot Planning
  progress('shot_plan', 'Generating per-shot prompts via LLM...');
  const plan = await planShots(scenes, { productDescription, instruction, model });
  progress('shot_plan', `Planned ${plan.shotCount} shots`);

  // Stage 3: Product Placement
  progress('product_place', 'Generating product-placed first frames...');
  const placed = await placeProducts(plan, { width, height, productImage });
  progress('product_place', `Generated ${placed.frames.filter(f => f.path).length}/${placed.shotCount} frames (source: ${placed.comfyAvailable ? 'ComfyUI' : 'reference fallback'})`);

  // Stage 4: Image-to-Video
  progress('animate', 'Animating frames into video clips...');
  const animated = await animateFrames(placed, plan, { fps, width, height });
  progress('animate', `Created ${animated.clipCount} clips (engine: ${animated.i2vAvailable ? animated.i2vModel : 'Ken Burns fallback'})`);

  // Stage 5: Concat
  progress('concat', 'Stitching final video...');
  const final = await concatClips(animated);
  progress('complete', `Final video: ${final.clipCount} clips, ${(final.size / 1024).toFixed(1)} KB`);

  return {
    jobId,
    duration: Date.now() - startTime,
    reference: {
      duration: scenes.duration,
      width: scenes.width,
      height: scenes.height,
      shots: scenes.shotCount,
    },
    pipeline: {
      sceneDetection: { shots: scenes.shotCount, threshold },
      shotPlan: { product: productDescription, instruction: instruction || null },
      productPlacement: { comfyAvailable: placed.comfyAvailable, generated: placed.frames.filter(f => f.source === 'comfyui').length, fallback: placed.frames.filter(f => f.source === 'reference_frame').length },
      animation: { i2vAvailable: animated.i2vAvailable, i2vModel: animated.i2vModel, clips: animated.clipCount, kenBurns: animated.clips.filter(c => c.source === 'ken_burns_fallback').length },
      concat: { clips: final.clipCount },
    },
    output: {
      url: final.url,
      path: final.path,
      size: final.size,
    },
    stages: {
      scenes,
      plan,
      placed,
      animated,
      final,
    },
  };
}

// Pipeline status check
export async function editRebuildStatus() {
  const ffmpegOk = await (async () => {
    try {
      await runFF('ffmpeg', ['-version'], 5000);
      return true;
    } catch { return false; }
  })();

  const comfyOk = await comfyuiStatus();
  const i2vOk = await checkI2VModel();

  const ollamaOk = await (async () => {
    try {
      const url = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  })();

  return {
    pipeline: 'edit-rebuild',
    description: 'Free Katana alternative — rebuild any video edit with your own product',
    stages: {
      scene_detect: { ready: ffmpegOk, engine: 'ffmpeg', note: ffmpegOk ? 'Scene detection ready' : 'ffmpeg not found' },
      shot_plan: { ready: ollamaOk, engine: 'Ollama LLM', note: ollamaOk ? 'Shot planning ready' : 'Ollama not running' },
      product_place: { ready: comfyOk.available, engine: 'ComfyUI/FLUX.1', note: comfyOk.available ? 'Product placement ready' : 'ComfyUI offline — will use reference frames as fallback' },
      animate: { ready: i2vOk.available, engine: i2vOk.model || 'Ken Burns fallback', note: i2vOk.available ? `I2V model ready: ${i2vOk.model}` : 'No I2V model — will use Ken Burns pan/zoom fallback' },
      concat: { ready: ffmpegOk, engine: 'ffmpeg', note: ffmpegOk ? 'Video concatenation ready' : 'ffmpeg not found' },
    },
    readyStages: [ffmpegOk, ollamaOk, comfyOk.available, i2vOk.available, ffmpegOk].filter(Boolean).length,
    totalStages: 5,
    canRun: ffmpegOk && ollamaOk,
    gracefulDegradation: !comfyOk.available || !i2vOk.available
      ? 'Pipeline will run with fallbacks — reference frames for placement, Ken Burns for animation'
      : 'All stages fully operational',
  };
}

export function listRebuilds(limit = 50) {
  try {
    return readdirSync(VIDEO_DIR)
      .filter(f => f.startsWith('rebuild-'))
      .sort((a, b) => {
        try { return statSync(join(VIDEO_DIR, b)).mtimeMs - statSync(join(VIDEO_DIR, a)).mtimeMs; }
        catch { return 0; }
      })
      .slice(0, Math.min(limit, 200))
      .map(f => {
        const s = statSync(join(VIDEO_DIR, f));
        return { name: f, size: s.size, url: videoUrl(f), modified: s.mtimeMs };
      });
  } catch { return []; }
}
