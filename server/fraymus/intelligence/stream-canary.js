// Ollama Stream Canary Interceptor — NDJSON Stream Monitoring + Secret Sanitization
// Ported from FraynixSuperOrganismV19.java V2 (OllamaStreamCanaryInterceptor)
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc
//
// Wraps Ollama streaming responses. Each token is:
//   1. Fed to the canary array (timing/entropy/phase)
//   2. Scanned for secret prefixes and transmuted via HyperTranscoder4D
//   3. Emitted clean to the consumer
//
// Usage: const interceptor = new StreamCanaryInterceptor(canaryArray);
//        const clean = interceptor.processToken(rawToken, tokenIndex);

import { TriangulatedHoneypotArray } from './canary.js';
import { sanitizeStreamText, SECRET_PREFIXES } from './transcoder4d.js';

function tailPrefixOverlap(text) {
  let maxOverlap = 0;
  for (const pfx of SECRET_PREFIXES) {
    for (let len = 1; len <= Math.min(pfx.length - 1, text.length); len++) {
      if (text.endsWith(pfx.slice(0, len))) {
        maxOverlap = Math.max(maxOverlap, len);
      }
    }
  }
  return maxOverlap;
}

function shannonEntropy(text) {
  if (!text || text.length === 0) return 0;
  const freq = {};
  for (const ch of text) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = text.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

export class StreamCanaryInterceptor {
  constructor(canaryArray = null, xorKey = 0x5A, stepAdd = 0x11) {
    this.canaryArray = canaryArray || new TriangulatedHoneypotArray();
    this.xorKey = xorKey;
    this.stepAdd = stepAdd;
    this.tokenCount = 0;
    this.totalRedactions = 0;
    this.lastTimestamp = null;
    this.entropyBaseline = 4.0;
    this.phaseBaseline = 0.5;
    this.alerts = [];
    this.prefixBuffer = '';
  }

  processToken(rawToken, tokenIndex = null, flush = false) {
    const idx = tokenIndex !== null ? tokenIndex : this.tokenCount;
    this.tokenCount++;

    const now = Date.now();
    if (this.lastTimestamp !== null) {
      const delta = now - this.lastTimestamp;
      this.canaryArray.observeTiming(50, delta);
    }
    this.lastTimestamp = now;

    const entropy = shannonEntropy(rawToken);
    this.canaryArray.observeEntropy(this.entropyBaseline, entropy);

    const phaseSignal = Math.sin(idx * 0.1) * 0.5 + 0.5;
    const normalizedLen = Math.min(1.0, rawToken.length / 20);
    this.canaryArray.observePhase(phaseSignal, normalizedLen);

    const combined = this.prefixBuffer + rawToken;
    this.prefixBuffer = '';

    const { sanitized, redactionCount } = sanitizeStreamText(combined, this.xorKey, this.stepAdd);
    this.totalRedactions += redactionCount;

    if (redactionCount > 0) {
      this.alerts.push({
        tokenIndex: idx, timestamp: now, redactionCount,
        type: 'secret_leak_intercepted',
      });
    }

    if (flush) return sanitized;

    const overlap = tailPrefixOverlap(sanitized);
    if (overlap > 0) {
      this.prefixBuffer = sanitized.slice(-overlap);
      return sanitized.slice(0, -overlap);
    }
    return sanitized;
  }

  processNdjsonLine(line) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.response) {
        parsed.response = this.processToken(parsed.response);
      }
      if (parsed.message?.content) {
        parsed.message.content = this.processToken(parsed.message.content);
      }
      return parsed;
    } catch {
      return { raw: this.processToken(line) };
    }
  }

  async *interceptStream(readableStream) {
    let buffer = '';
    const decoder = new TextDecoder();

    for await (const chunk of readableStream) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          yield this.processNdjsonLine(line);
        }
      }
    }

    if (buffer.trim()) {
      yield this.processNdjsonLine(buffer);
    }
    if (this.prefixBuffer) {
      const tail = this.prefixBuffer;
      this.prefixBuffer = '';
      yield { flushed: tail };
    }
  }

  getTriangulation(seed = Date.now()) {
    return this.canaryArray.triangulateFault(seed);
  }

  getStats() {
    return {
      tokenCount: this.tokenCount,
      totalRedactions: this.totalRedactions,
      alertCount: this.alerts.length,
      canaries: this.canaryArray.toJSON(),
      triangulation: this.getTriangulation(),
    };
  }

  reset() {
    this.tokenCount = 0;
    this.totalRedactions = 0;
    this.lastTimestamp = null;
    this.alerts = [];
    this.prefixBuffer = '';
    this.canaryArray.reset();
  }

  toJSON() {
    return this.getStats();
  }
}

export default { StreamCanaryInterceptor, shannonEntropy };
