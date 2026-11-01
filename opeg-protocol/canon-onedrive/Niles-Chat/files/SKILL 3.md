# image-generation skill - UPDATED

## Standing Rules (folded in from decision-matrix audit)

### NEW: Multi-step → Skill, don't inline
If image generation requires >2 steps (prompt engineering, reference search, generation, validation, artifact creation), promote to skill workflow.

### NEW: Verification gates (from pattern audit)
Before claiming image generation succeeded:
1. Check file exists at /mnt/data/...
2. Validate it's not 0-byte
3. For physics / data plots: check invariants (M collapse >80% etc)
4. For maps / geography: require image search reference, don't invent coastlines

### Existing workflow
- Use image_gen tool with proper Additional Instruction for geography
- Pass local files to artifact creator
- Don't use placeholder gradients
