# Phase 54: Carbon X Core — Biological Encoding System

**Date:** 2026-10-31  
**Previous:** [Phase 53: Edit Rebuild Pipeline](PHASE-53.md)

## Overview

Carbon X is Chandra's proprietary biological continuity system — encoding workspace state as real DNA sequences that standard bioinformatics tools (BLAST, BioPython) can parse. This phase implements the 4-layer encoding stack from nucleotide base through full organism snapshots.

## Architecture: 4-Layer Stack

| Layer | Module | Purpose |
|-------|--------|---------|
| 1 — Nucleotide Base | `encoding/dna.js` (existing) | 2-bit ACGT encoding, GC analysis, HDC hypervectors |
| 2 — Codon Engine | `encoding/codon.js` (new) | 64 codons, ATG/TAA framing, nibble-pair byte encoding, FNV-1a checksums |
| 3 — Plasmid Forge | `encoding/plasmid.js` (new) | Circular DNA with ori, promoters, restriction sites — transferable skill units |
| 4 — Organism | `encoding/carbon.js` (new) | Genome (config) + Proteome (state) + Epigenome (context) snapshots as FASTA |

## New Files

### `server/fraymus/encoding/codon.js` — Layer 2: Codon Engine
- **64 codons** (3 DNA bases each) in canonical ACGT order
- **ATG start codon** (methionine) marks frame beginning
- **TAA/TAG/TGA stop codons** mark frame end
- **Nibble-pair encoding:** each byte → 2 codons (high nibble + low nibble), 16 values per nibble
- **FNV-1a 32-bit checksum** embedded in every frame
- **Self-describing frames:** length header allows blind decode without external metadata
- Exports: `encodeCodon()`, `decodeCodon()`, `codonGcContent()`, `codonStats()`

### `server/fraymus/encoding/plasmid.js` — Layer 3: Plasmid Forge
- **Biological anatomy:** ori (replication origin), Pribnow box promoters, poly-A terminator
- **Restriction sites:** EcoRI, BamHI, HindIII, NotI — real enzyme recognition sequences
- **Gene scanning:** finds ATG...TAA open reading frames (not dependent on restriction site positions)
- **Round-trip verified:** forge → digest recovers original payload with SHA-256 integrity check
- **FASTA export:** standard bioinformatics format, parseable by NCBI BLAST
- **Restriction digest simulation:** cut DNA at enzyme sites, report fragment sizes
- Exports: `forgePlasmid()`, `digestPlasmid()`, `plasmidToFasta()`, `fastaToPlaymid()`, `restrictionDigest()`

### `server/fraymus/encoding/carbon.js` — Layer 4: Organism
- **3-chromosome genome:** chr1_genome (config), chr2_proteome (state), chr3_epigenome (context)
- **Workspace snapshot:** agents, workflows, settings, tools, bus topics, memories, reflections, fossils
- **FASTA multi-entry:** standard multi-sequence FASTA format
- **Checkpoint/restore:** save to disk as `.fasta` + `.meta.json` sidecar, load with integrity verification
- Exports: `createGenomeSnapshot()`, `restoreFromSnapshot()`, `saveCheckpoint()`, `loadCheckpoint()`, `listCheckpoints()`

### `server/fraymus/carbon-routes.js` — REST API (11 endpoints)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/carbon/encode` | POST | Encode text/bytes → codon sequence |
| `/api/carbon/decode` | POST | Decode codon sequence → text/bytes |
| `/api/carbon/stats` | POST | Codon statistics for any DNA sequence |
| `/api/carbon/plasmid/forge` | POST | Forge plasmid from payload |
| `/api/carbon/plasmid/digest` | POST | Extract payload from plasmid DNA |
| `/api/carbon/plasmid/fasta` | POST | Convert plasmid to FASTA format |
| `/api/carbon/plasmid/restrict` | POST | Restriction enzyme digest simulation |
| `/api/carbon/checkpoint` | POST | Create genome checkpoint from workspace |
| `/api/carbon/restore` | POST | Restore workspace from checkpoint |
| `/api/carbon/checkpoints` | GET | List all saved checkpoints |
| `/api/carbon/status` | GET | Carbon X system status |

## Key Design Decisions

### Why Nibble-Pair Encoding (not direct byte-to-codon)?
With 60 sense codons (64 minus ATG, TAA, TAG, TGA), we can't map all 256 byte values 1:1. Nibble-pair encoding splits each byte into high/low nibbles (0-15 each), using only 16 of the 60 sense codons. This guarantees no codon in the data portion is ever a stop codon, eliminating frame ambiguity.

### Why Gene Scanning (not restriction site parsing)?
Restriction site sequences (e.g., GGATCC for BamHI) are only 6 bases long and can appear by chance inside codon-encoded data. Instead of relying on restriction sites as structural delimiters, we scan for sequential ATG...TAA open reading frames — the biological reading frame is unambiguous.

### Why FASTA Format?
FASTA is the universal interchange format in bioinformatics. Our checkpoint files are valid FASTA — you can paste them into NCBI BLAST, load them in BioPython, or analyze them with any standard genomics tool. This isn't a gimmick — it means Carbon X data is interoperable with the entire bioinformatics ecosystem.

## Test Results

```
Codon Engine:
  ✓ Round-trip text encoding: "Hello Carbon X!" → 144 bases → "Hello Carbon X!"
  ✓ Binary data round-trip: [0, 1, 127, 128, 255, 42, 99, 200] → encode → decode → match
  ✓ Empty data handling
  ✓ Stats: GC content 29.17%, 1 start codon, 1 stop codon, 1 ORF

Plasmid Forge:
  ✓ Forge: 2018 bases, GC 35.63%, 8 biological features
  ✓ Digest: verified round-trip, payload matches original
  ✓ FASTA export: valid header with metadata
  ✓ Restriction digest: EcoRI cuts at 1 site, 2 fragments
  ✓ Large payload: 20-agent fleet config → 10148 bases → round-trip match

Organism (Carbon X):
  ✓ Genome snapshot: 3 chromosomes, 3408 total bases
  ✓ Restore: all 3 layers (genome/proteome/epigenome) recovered
  ✓ Agent match: restored agents identical to input
  ✓ Settings match: restored settings identical to input
  ✓ Checkpoint save/load: disk persistence with integrity verification
```

## Wiring

- `server/runtime.js` — imports `installCarbonRoutes`, called with `{ dataDir: DATA_DIR, broadcast, db }`
- WebSocket events: `carbon:plasmid_forged`, `carbon:checkpoint_created`, `carbon:restored`
- Checkpoints saved to `data/carbon/` directory

## Feature Count

**63 features** (was 62 in Phase 53, +1 Carbon X biological encoding system)
