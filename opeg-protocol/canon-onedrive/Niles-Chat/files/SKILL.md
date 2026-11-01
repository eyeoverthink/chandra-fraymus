# citation-ledger skill

## Purpose
Standardized workflow for citation-backed artifact generation. Extracted from 3x repeated manual runs. This was the exact gap noted: multi-step plan was being inlined instead of becoming a skill.

## Trigger
Any task that requires:
- Source verification for claims
- Ledger / provenance report
- Multi-source synthesis with citations

## Workflow (formalized from previous runs)

### Phase 1: Source Tracker
1. Read source material (paper, patent, article) fully
2. Extract claims with line numbers
3. Create lineage_report.json: {claim, source_url, line, confidence}

### Phase 2: Verification
- For physics / math claims: check invariants
  - Vicsek M(eta=0) > 0.9, M(eta>>1) < 0.3
  - Circular mean for angles: angle(mean(exp(i*theta)))
  - No global mean for local models
- For code: run + byte-identical deterministic check
- For WASM: verify binary exists, check magic bytes 0x00 0x61 0x73 0x6D

### Phase 3: Artifact Generation
- Generate artifact with citations embedded
- Each factual block gets source ref
- Save ledger as separate file

### Phase 4: Standing Rule (NEW from decision-matrix.md)
- If workflow > 2 steps and repeated > 2x, promote to skill immediately
- Don't inline as one-off script

## Implementation files
- com.fraymus.metal.SourceTracker (Java engine placeholder)
- src/lib/sourceTracker.js (JS wrapper)
- lineage_report.json (example)

## Verification command
javac + wasmtime + glyphsmith UI
