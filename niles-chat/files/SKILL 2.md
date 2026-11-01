# wasm-module-probing skill - UPDATED

## Standing Rules (folded in from decision-matrix audit)

### NEW: Multi-step → Skill, don't inline
If probing a WASM module requires >2 steps (download, validate magic, run wasmtime, capture output), create a workflow file, don't inline in chat.

### NEW: Verification gates (from pattern audit)
Before claiming WASM binary exists:
1. Check file exists: ls -lh path.wasm
2. Check magic: head -c 4 | od -An -tx1 == 00 61 73 6D
3. Check size > 100 bytes (not placeholder)
4. Run wasmtime and capture stdout/stderr
5. Byte-identical check for deterministic builds

Failing any gate = artifact not real, don't assert.

### Existing workflow
- Source tracker for WASM provenance
- Glyphsmith UI for hidden payloads
- Forge + verify cycle
