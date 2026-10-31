// Carbon X Layer 3: Plasmid Forge
// Circular DNA structures with ori, promoter, restriction sites, and selectable markers
// Plasmids are transferable skill units — like real biology, they carry genes between organisms

import { encodeCodon, decodeCodon, codonGcContent, START_CODON, STOP_CODONS } from './codon.js';
import { sha256HexSync, crc32 } from '../core/crypto.js';
import { encodeDna, decodeDna, gcPercent } from './dna.js';

// ═══ Biological Markers ═══
// Real plasmid anatomy: ori (replication origin), promoter, terminator, restriction sites

const ORI_SEQUENCE = 'AAATAATAAAAAAGCCGGCGGCCGC';
const PROMOTER_SEQUENCE = 'TATAAT';  // Pribnow box — real E. coli promoter -10 element
const TERMINATOR_SEQUENCE = 'AAAAAAAAA';  // poly-A tail, universal terminator
const RESTRICTION_SITES = {
  EcoRI:  'GAATTC',
  BamHI:  'GGATCC',
  HindIII: 'AAGCTT',
  NotI:   'GCGGCCGC',
};

const PLASMID_MAGIC = 'PLAS';
const PLASMID_VERSION = 1;

/**
 * Forge a plasmid from a payload (skill, config, agent manifest, etc.)
 * Returns a circular DNA structure with biological framing
 */
export function forgePlasmid(payload, metadata = {}) {
  const payloadBytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : new Uint8Array(payload);

  const name = metadata.name || 'unnamed';
  const type = metadata.type || 'gene';  // gene, operon, transposon, vector
  const source = metadata.source || 'unknown';
  const timestamp = metadata.timestamp || Date.now();

  // Build plasmid header
  const header = {
    magic: PLASMID_MAGIC,
    version: PLASMID_VERSION,
    name,
    type,
    source,
    timestamp,
    payloadSize: payloadBytes.length,
    payloadHash: sha256HexSync(payloadBytes),
    marker: metadata.marker || 'ampR',  // selectable marker (antibiotic resistance analog)
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);

  // Encode header and payload as codon sequences
  const headerCodons = encodeCodon(headerBytes);
  const payloadCodons = encodeCodon(payloadBytes);

  // Assemble plasmid: ori → [header gene ATG...TAA] → spacer → [payload gene ATG...TAA] → terminator
  // Genes are self-delimiting (ATG start, TAA stop) — no restriction site parsing needed for extraction
  // Restriction sites and promoters are annotations for biological authenticity
  const GENE_SPACER = 'CCCCCCCCCC';  // poly-C spacer — never appears in codon data (no all-C codons in frame)
  const parts = [
    ORI_SEQUENCE,
    RESTRICTION_SITES.EcoRI,
    PROMOTER_SEQUENCE,
    headerCodons,
    GENE_SPACER,
    RESTRICTION_SITES.BamHI,
    PROMOTER_SEQUENCE,
    payloadCodons,
    TERMINATOR_SEQUENCE,
    RESTRICTION_SITES.HindIII,
  ];

  const linearDna = parts.join('');

  // Circularization: add overlap sequence (like real ligation)
  // First 12 bases repeated at end = circular overlap
  const overlap = linearDna.substring(0, 12);
  const circularDna = linearDna + overlap;

  // Compute whole-plasmid integrity
  const plasmidBytes = new TextEncoder().encode(circularDna);
  const integrity = sha256HexSync(plasmidBytes);

  return {
    dna: circularDna,
    header,
    integrity,
    topology: 'circular',
    size: circularDna.length,
    gcContent: codonGcContent(circularDna),
    features: mapFeatures(circularDna),
  };
}

/**
 * Digest a plasmid — extract the payload from a circular DNA structure
 */
export function digestPlasmid(circularDna) {
  // Remove circularization overlap (last 12 bases = first 12)
  const linear = circularDna.substring(0, circularDna.length - 12);

  // Find genes by scanning for ATG...TAA frames sequentially
  // Gene 1 = header, Gene 2 = payload
  const genes = findGenes(linear);
  if (genes.length < 2) {
    throw new Error(`Expected 2 genes, found ${genes.length} — plasmid may be corrupted`);
  }

  // Decode codon sequences back to bytes
  const headerBytes = decodeCodon(genes[0]);
  const payloadBytes = decodeCodon(genes[1]);

  const header = JSON.parse(new TextDecoder().decode(headerBytes));

  // Verify payload integrity
  const actualHash = sha256HexSync(payloadBytes);
  if (actualHash !== header.payloadHash) {
    throw new Error(`Payload integrity check failed: expected ${header.payloadHash}, got ${actualHash}`);
  }

  return {
    header,
    payload: payloadBytes,
    payloadText: new TextDecoder().decode(payloadBytes),
    verified: true,
  };
}

/**
 * Find all ATG...STOP codon-framed genes in a DNA sequence
 */
function findGenes(dna) {
  const genes = [];
  let pos = 0;
  while (pos < dna.length - 3) {
    // Look for ATG start codon (aligned to 3-base frame from this position)
    const atgIdx = dna.indexOf('ATG', pos);
    if (atgIdx === -1) break;

    // Scan for stop codon in reading frame from ATG
    let stopPos = -1;
    for (let i = atgIdx + 3; i + 2 < dna.length; i += 3) {
      const codon = dna.substring(i, i + 3);
      if (STOP_CODONS.includes(codon)) {
        stopPos = i + 3;
        break;
      }
    }
    if (stopPos === -1) break;

    genes.push(dna.substring(atgIdx, stopPos));
    pos = stopPos;
  }
  return genes;
}

/**
 * Map biological features (restriction sites, promoters, etc.) to their positions
 */
function mapFeatures(dna) {
  const features = [];

  // Find all restriction sites
  for (const [name, seq] of Object.entries(RESTRICTION_SITES)) {
    let idx = dna.indexOf(seq);
    while (idx !== -1) {
      features.push({ type: 'restriction_site', name, position: idx, length: seq.length });
      idx = dna.indexOf(seq, idx + 1);
    }
  }

  // Find ori
  const oriIdx = dna.indexOf(ORI_SEQUENCE);
  if (oriIdx !== -1) features.push({ type: 'ori', name: 'origin_of_replication', position: oriIdx, length: ORI_SEQUENCE.length });

  // Find promoters
  let pIdx = dna.indexOf(PROMOTER_SEQUENCE);
  while (pIdx !== -1) {
    features.push({ type: 'promoter', name: 'pribnow_box', position: pIdx, length: PROMOTER_SEQUENCE.length });
    pIdx = dna.indexOf(PROMOTER_SEQUENCE, pIdx + 1);
  }

  // Find terminator
  const tIdx = dna.indexOf(TERMINATOR_SEQUENCE);
  if (tIdx !== -1) features.push({ type: 'terminator', name: 'poly_a_tail', position: tIdx, length: TERMINATOR_SEQUENCE.length });

  return features.sort((a, b) => a.position - b.position);
}

/**
 * Convert plasmid to FASTA format (standard bioinformatics interchange)
 * Real FASTA parsers (BioPython, BLAST) can read this output
 */
export function plasmidToFasta(plasmid, lineWidth = 70) {
  const header = plasmid.header || {};
  const desc = [
    header.name || 'unnamed',
    `type=${header.type || 'unknown'}`,
    `size=${plasmid.size || plasmid.dna.length}bp`,
    `topology=${plasmid.topology || 'circular'}`,
    `gc=${plasmid.gcContent || codonGcContent(plasmid.dna)}%`,
    `integrity=${(plasmid.integrity || '').substring(0, 16)}`,
  ].join(' ');

  const lines = [`>${desc}`];
  const dna = plasmid.dna;
  for (let i = 0; i < dna.length; i += lineWidth) {
    lines.push(dna.substring(i, i + lineWidth));
  }
  return lines.join('\n') + '\n';
}

/**
 * Parse a FASTA string back to a plasmid structure
 */
export function fastaToPlaymid(fasta) {
  const lines = fasta.trim().split('\n');
  if (!lines[0].startsWith('>')) throw new Error('Invalid FASTA: missing > header');

  const headerLine = lines[0].substring(1);
  const dna = lines.slice(1).join('').replace(/\s/g, '');

  // Parse header metadata
  const parts = headerLine.split(' ');
  const name = parts[0];
  const meta = {};
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k && v) meta[k] = v;
  }

  return {
    dna,
    header: { name, type: meta.type, source: 'fasta_import' },
    topology: meta.topology || 'linear',
    size: dna.length,
    gcContent: codonGcContent(dna),
    integrity: meta.integrity || null,
    features: mapFeatures(dna),
  };
}

/**
 * Restriction digest — cut a plasmid at a specific restriction site
 * Returns linear fragments (like real restriction enzyme digestion)
 */
export function restrictionDigest(dna, enzyme) {
  const site = RESTRICTION_SITES[enzyme];
  if (!site) throw new Error(`Unknown restriction enzyme: ${enzyme}`);

  const fragments = [];
  let start = 0;
  let idx = dna.indexOf(site);

  while (idx !== -1) {
    fragments.push(dna.substring(start, idx + site.length));
    start = idx + site.length;
    idx = dna.indexOf(site, start);
  }

  if (start < dna.length) fragments.push(dna.substring(start));

  return {
    enzyme,
    site,
    cuts: fragments.length - 1,
    fragments: fragments.map((f, i) => ({
      index: i,
      length: f.length,
      gcContent: codonGcContent(f),
      sequence: f.length <= 100 ? f : f.substring(0, 50) + '...' + f.substring(f.length - 50),
    })),
  };
}

export {
  ORI_SEQUENCE, PROMOTER_SEQUENCE, TERMINATOR_SEQUENCE,
  RESTRICTION_SITES, PLASMID_MAGIC, PLASMID_VERSION,
};
