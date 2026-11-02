// Chrono-Spore Engine — Living Stream Organisms
// Each streamer gets a SporeOrganism: a 160-byte genome (0x20–0xBF) that mutates
// with every donation. Telemetry (audio peak, chat velocity, stream tick) drives
// the XOR mutation key. At end-of-stream, the genome is fossilized.

import { encodeDna } from '../fraymus/encoding/dna.js';
import { encodeCodon } from '../fraymus/encoding/codon.js';
import { signMessage } from '../fraymus/core/signing.js';
import { sha256HexSync } from '../fraymus/core/crypto.js';

const GENOME_SIZE = 160; // bytes 0x20–0xBF
const DNA_BASES = ['A', 'C', 'G', 'T'];

function seedGenome(streamerId) {
  const genome = new Uint8Array(GENOME_SIZE);
  let hash = 0x811c9dc5;
  for (let i = 0; i < streamerId.length; i++) {
    hash ^= streamerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  for (let i = 0; i < GENOME_SIZE; i++) {
    hash ^= i;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    genome[i] = hash & 0xFF;
  }
  return genome;
}

function deriveMutationKey(donorName, amount, streamTick, audioPeak, chatVelocity) {
  let key = 0;
  for (let i = 0; i < donorName.length; i++) key ^= donorName.charCodeAt(i);
  key = (key ^ Math.floor(amount * 13) ^ (streamTick || 0) ^ (audioPeak || 0)) & 0xFF;
  const spread = (chatVelocity || 1) & 0xFF;
  return { key, spread };
}

function mutateGenome(genome, mutationKey, spread, amount) {
  const reach = Math.min(GENOME_SIZE, Math.max(4, Math.floor(amount * 2)));
  const offset = (mutationKey * 7) % GENOME_SIZE;
  for (let i = 0; i < reach; i++) {
    const idx = (offset + i) % GENOME_SIZE;
    genome[idx] ^= (mutationKey + i * spread) & 0xFF;
  }
}

function extractDna16(genome) {
  const slice = genome.slice(0, 16);
  let dna = '';
  for (const byte of slice) {
    dna += DNA_BASES[(byte >> 6) & 3];
    dna += DNA_BASES[(byte >> 4) & 3];
    dna += DNA_BASES[(byte >> 2) & 3];
    dna += DNA_BASES[byte & 3];
    dna += ' ';
  }
  return dna.trim();
}

function genomeVisuals(genome) {
  const r = genome[0], g = genome[1], b = genome[2];
  const pulseRate = 0.5 + (genome[3] / 255) * 2.5;
  const symmetry = (genome[4] % 8) + 3;
  const complexity = (genome[5] % 5) + 1;
  const hue = Math.round((genome[6] / 255) * 360);
  return {
    color: `rgb(${r},${g},${b})`,
    hue,
    pulseRate: +pulseRate.toFixed(2),
    symmetry,
    complexity,
    glow: genome[7] / 255,
  };
}

export class SporeOrganism {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.genome = seedGenome(streamerId);
    this.generation = 0;
    this.mutations = [];
    this.contributors = new Map();
    this.createdAt = Date.now();
    this.fossilized = false;
    this.fossilData = null;
  }

  mutate({ donorName, donorId, amount, message, audioPeak, chatVelocity, streamTick }) {
    if (this.fossilized) throw new Error('Organism is fossilized — no further mutations');

    const { key, spread } = deriveMutationKey(donorName, amount, streamTick, audioPeak, chatVelocity);
    const prevHash = sha256HexSync(this.genome);
    mutateGenome(this.genome, key, spread, amount);
    this.generation++;

    const mutation = {
      generation: this.generation,
      donorName,
      donorId: donorId || `anon_${Date.now().toString(36)}`,
      amount,
      message: (message || '').slice(0, 200),
      mutationKey: key.toString(16).toUpperCase().padStart(2, '0'),
      reach: Math.min(GENOME_SIZE, Math.max(4, Math.floor(amount * 2))),
      audioPeak: audioPeak || 0,
      chatVelocity: chatVelocity || 0,
      streamTick: streamTick || 0,
      prevHash,
      newHash: sha256HexSync(this.genome),
      timestamp: Date.now(),
    };
    this.mutations.push(mutation);

    const existing = this.contributors.get(donorName) || { count: 0, totalAmount: 0 };
    existing.count++;
    existing.totalAmount += amount;
    this.contributors.set(donorName, existing);

    return {
      generation: this.generation,
      mutation,
      dna16: extractDna16(this.genome),
      fullDna: encodeDna(this.genome),
      visuals: genomeVisuals(this.genome),
      genomeHash: mutation.newHash,
    };
  }

  async fossilize(identity) {
    if (this.fossilized) return this.fossilData;

    this.fossilized = true;
    const finalHash = sha256HexSync(this.genome);
    const codon = encodeCodon(this.genome);
    const fullDna = encodeDna(this.genome);

    const contributors = [];
    for (const [name, stats] of this.contributors) {
      contributors.push({ name, ...stats });
    }

    const signed = identity
      ? await signMessage(identity, this.streamerId, {
          type: 'chrono-spore-fossil',
          generation: this.generation,
          genome_sha256: finalHash,
          contributors: contributors.length,
          fossilized_at: new Date().toISOString(),
        }, 'fossil')
      : null;

    this.fossilData = {
      id: `fossil_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      streamerId: this.streamerId,
      generation: this.generation,
      genomeSha256: finalHash,
      dna16: extractDna16(this.genome),
      fullDna,
      codonLength: codon.length,
      visuals: genomeVisuals(this.genome),
      contributors,
      totalMutations: this.mutations.length,
      lifespanMs: Date.now() - this.createdAt,
      signature: signed,
      fossilizedAt: Date.now(),
    };

    return this.fossilData;
  }

  getState() {
    return {
      streamerId: this.streamerId,
      generation: this.generation,
      fossilized: this.fossilized,
      dna16: extractDna16(this.genome),
      fullDna: encodeDna(this.genome),
      visuals: genomeVisuals(this.genome),
      genomeHash: sha256HexSync(this.genome),
      contributorCount: this.contributors.size,
      mutationCount: this.mutations.length,
      recentMutations: this.mutations.slice(-5),
      lifespanMs: Date.now() - this.createdAt,
    };
  }

  getContributors() {
    const list = [];
    for (const [name, stats] of this.contributors) list.push({ name, ...stats });
    return list.sort((a, b) => b.totalAmount - a.totalAmount);
  }
}

export class SporeRegistry {
  constructor() {
    this.organisms = new Map();
  }

  getOrCreate(streamerId) {
    if (!this.organisms.has(streamerId)) {
      this.organisms.set(streamerId, new SporeOrganism(streamerId));
    }
    return this.organisms.get(streamerId);
  }

  get(streamerId) {
    return this.organisms.get(streamerId) || null;
  }

  reset(streamerId) {
    this.organisms.delete(streamerId);
    return this.getOrCreate(streamerId);
  }

  list() {
    const out = [];
    for (const [id, org] of this.organisms) {
      out.push({
        streamerId: id,
        generation: org.generation,
        fossilized: org.fossilized,
        contributors: org.contributors.size,
        lifespanMs: Date.now() - org.createdAt,
      });
    }
    return out;
  }
}
