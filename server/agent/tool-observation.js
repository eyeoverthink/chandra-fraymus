import { validateImage } from '../image-validation.js';
import { fail } from './schema.js';

const BRAND = Symbol('server-created-tool-observation');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const imageCost = bytes => 4096 + Math.ceil(bytes / 1024);

// Only trusted server tools create this envelope. JSON fields named "images"
// never become native image input, and pixels never enter durable tool JSON.
export function toolObservation(result, images = []) {
  return Object.freeze({ [BRAND]: { result, images } });
}

export function consumeToolObservation(value, { run, metadata, provider }) {
  if (!value || !Object.hasOwn(value, BRAND)) return { result: value, images: [], estimate: 0 };
  const envelope = value[BRAND];
  if (!envelope || !Array.isArray(envelope.images) || envelope.images.length > 1) fail('invalid_observation', 'At most one selected-window frame may accompany an observation');
  if (envelope.images.length && (provider !== 'ollama' || run?.allowCloud || !metadata?.vision)) fail('observation_vision_required', 'Desktop image observations require an explicitly local vision-capable model');
  let estimate = 0;
  const images = envelope.images.map(image => {
    if (!image || image.scope !== 'desktop-window' || image.runId !== run?.id || image.sessionId !== run?.desktopSessionId
      || !ID.test(image.snapshotId || '') || !Buffer.isBuffer(image.bytes) || image.mimeType !== 'image/png'
      || !image.bytes.length || image.bytes.length > 4 * 1024 * 1024) fail('invalid_observation', 'Image observation ownership, type or byte limit is invalid');
    const dimensions = validateImage(image.bytes, image.mimeType);
    if (dimensions.width !== image.width || dimensions.height !== image.height || dimensions.width * dimensions.height > 2073600) fail('invalid_observation', 'Selected-window image dimensions are invalid or exceed 2,073,600 pixels');
    estimate += imageCost(image.bytes.length);
    return { data: image.bytes.toString('base64'), scope: image.sessionId, snapshotId: image.snapshotId,
      bytes: image.bytes.length, width: image.width, height: image.height };
  });
  return { result: envelope.result, images, estimate };
}
