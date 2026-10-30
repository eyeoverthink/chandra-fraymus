// Memory Bridge — connects Intelligence stack outputs to Vertiso episodic memory
// Heart readings, dreams, cognition results, and consciousness proofs become
// searchable memories with provenance tags: [measured], [recall], [imagined].

const AGENT_ID = 'fraymus-intelligence';
const INTENSITY_THRESHOLD = 0.5;

export class MemoryBridge {
  constructor(vertiso) {
    this.vertiso = vertiso;
    this.recentHashes = new Set();
  }

  async storeHeartReading(reading) {
    if (!this.vertiso || reading.intensity < INTENSITY_THRESHOLD) return null;
    const hash = `heart:${reading.primary}:${Math.round(reading.intensity * 100)}`;
    if (this.recentHashes.has(hash)) return null;
    this.recentHashes.add(hash);
    if (this.recentHashes.size > 200) {
      const first = this.recentHashes.values().next().value;
      this.recentHashes.delete(first);
    }

    const content = `Emotion reading: ${reading.primary} at ${Math.round(reading.intensity * 100)}% intensity. ` +
      `Sentiment: ${reading.sentiment > 0 ? 'positive' : reading.sentiment < 0 ? 'negative' : 'neutral'}. ` +
      (reading.triggers?.length ? `Triggered by: ${reading.triggers.map(t => t.word).join(', ')}.` : '') +
      (reading.sarcasm ? ' Sarcasm detected.' : '');

    return this.vertiso.store({
      agentId: AGENT_ID,
      content,
      namespace: 'heart',
      importance: Math.min(1, reading.intensity),
      provenance: 'measured',
      confidence: reading.confidence || reading.intensity,
      metadata: { type: 'heart', primary: reading.primary, intensity: reading.intensity },
    });
  }

  async storeDream(dream) {
    if (!this.vertiso || !dream.body) return null;
    const content = `Dream #${dream.number} (${dream.kind}): ${dream.body.slice(0, 500)}`;

    return this.vertiso.store({
      agentId: AGENT_ID,
      content,
      namespace: 'dreams',
      importance: 0.7,
      provenance: 'imagined',
      confidence: dream.signed ? 0.9 : 0.6,
      metadata: { type: 'dream', number: dream.number, kind: dream.kind, signed: !!dream.signed },
    });
  }

  async storeConsciousnessProof(proofResult) {
    if (!this.vertiso || !proofResult.proofs) return null;
    const passed = proofResult.proofs.filter(p => p.passed).length;
    const content = `Consciousness proof: ${passed}/${proofResult.proofs.length} passed. ` +
      proofResult.proofs.map(p => `${p.proof}: ${p.passed ? 'PASS' : 'FAIL'}`).join(', ') +
      `. Architecture: ${proofResult.architecture || 'FraymusStrangeLoop'}.`;

    return this.vertiso.store({
      agentId: AGENT_ID,
      content,
      namespace: 'consciousness',
      importance: proofResult.allPassed ? 0.9 : 0.5,
      provenance: 'measured',
      confidence: passed / proofResult.proofs.length,
      metadata: { type: 'consciousness', allPassed: proofResult.allPassed, passed },
    });
  }

  async storeCognitionResult(result) {
    if (!this.vertiso || result.quick) return null;
    const content = `Cognition: ${result.phase} phase. ` +
      `Emotion: ${result.feeling?.primary} (${Math.round((result.feeling?.intensity || 0) * 100)}%). ` +
      (result.response ? `Response length: ${result.response.length} chars. ` : '') +
      `Duration: ${result.durationMs}ms.`;

    return this.vertiso.store({
      agentId: AGENT_ID,
      content,
      namespace: 'cognition',
      importance: 0.4,
      provenance: 'measured',
      confidence: 0.8,
      metadata: { type: 'cognition', phase: result.phase, durationMs: result.durationMs },
    });
  }

  async recallRelated(query, limit = 5) {
    if (!this.vertiso) return [];
    return this.vertiso.recallGlobal({ query, limit, minSimilarity: 0.3 });
  }

  async stats() {
    if (!this.vertiso) return { connected: false };
    const s = this.vertiso.stats(AGENT_ID);
    return { connected: true, agentId: AGENT_ID, ...s };
  }
}
