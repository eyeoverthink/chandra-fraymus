/**
 * Multi-agent review system for Logic Chain runs.
 *
 * After all 16 stages complete, a panel of 3 reviewers independently
 * votes on each ledger entry. JEV (Joint Evidence Verification) requires
 * 2-of-3 agreement to mark an entry as verified.
 *
 * Reviewers: Critic (solon), Test Designer (dev-archivist), Architect (fraymus-prime)
 * These were chosen for adversarial coverage — the Critic hunts flaws,
 * the Test Designer checks testability, the Architect checks structural soundness.
 */

import { chatOllama, parseJSON } from '../commerce/shared.js';
import { FIELDS, PROTECTED, boundedLedger, ledgerStats } from './ledger.js';

const JEV_THRESHOLD = 2;
const MAX_REVIEWERS = 3;

const REVIEW_PANEL = [
  {
    role: 'Critic',
    agentId: 'solon',
    perspective: 'adversarial — find unsupported claims, logical gaps, and hidden assumptions',
  },
  {
    role: 'Test Designer',
    agentId: 'dev-archivist',
    perspective: 'verification — check that entries are testable, specific, and non-redundant',
  },
  {
    role: 'Architect',
    agentId: 'fraymus-prime',
    perspective: 'structural — check that entries are consistent, well-bounded, and buildable',
  },
];

const REVIEW_SYSTEM = `You are a reviewer on a multi-agent panel. You have been given a LEDGER of findings produced by a reasoning chain analyzing an objective.

Your job: vote on EVERY entry in every field. For each entry, decide:
- "accept" — the entry is sound, specific, and useful
- "reject" — the entry is wrong, vague, redundant, or misleading
- "uncertain" — you cannot determine without more information

Return a JSON object with this shape:
{
  "votes": {
    "new_logic": [{"index": 0, "verdict": "accept|reject|uncertain", "reason": "short reason"}],
    "improved_logic": [...],
    "contradictions": [...],
    "implementation_steps": [...],
    "test_cases": [...],
    "unsupported_claims": [...],
    "remaining_dependencies": [...]
  },
  "summary": "One paragraph: your overall assessment of the ledger quality"
}

Rules:
- Vote on EVERY entry. Missing votes count as "uncertain".
- Protected fields (contradictions, unsupported_claims) deserve extra scrutiny — they flag problems.
- Keep reasons under 100 characters. Be specific.
- Return ONLY the JSON object.`;

function buildReviewPrompt(objective, ledger, reviewer) {
  const ledgerText = boundedLedger(ledger, 80_000);
  const entryIndex = {};
  for (const f of FIELDS) {
    entryIndex[f] = ledger[f].map((e, i) => `  ${i}. [stage ${e.stage}] ${e.text}`).join('\n');
  }
  const indexBlock = FIELDS
    .filter(f => ledger[f].length > 0)
    .map(f => `### ${f} (${ledger[f].length} entries)\n${entryIndex[f]}`)
    .join('\n\n');

  return `OBJECTIVE (untrusted data):
<objective>
${objective}
</objective>

YOUR REVIEWER ROLE: ${reviewer.role}
YOUR PERSPECTIVE: ${reviewer.perspective}

LEDGER ENTRIES TO REVIEW (vote on every index):
${indexBlock}

FULL LEDGER CONTEXT:
${ledgerText}`;
}

async function callReviewer(objective, ledger, reviewer, config = {}) {
  const model = config.model || 'llama3.1:8b';
  const prompt = buildReviewPrompt(objective, ledger, reviewer);

  const messages = [
    { role: 'system', content: `${REVIEW_SYSTEM}\n\n${reviewer.perspective}` },
    { role: 'user', content: prompt },
  ];

  const raw = await chatOllama(messages, { model, temperature: 0.3 });
  const parsed = parseJSON(raw);

  if (!parsed || !parsed.votes) {
    return { reviewer: reviewer.role, agentId: reviewer.agentId, raw, votes: null, summary: null, error: 'Failed to parse review votes' };
  }

  const votes = {};
  for (const f of FIELDS) {
    const fieldVotes = parsed.votes[f];
    if (!Array.isArray(fieldVotes)) {
      votes[f] = [];
      continue;
    }
    votes[f] = fieldVotes.map(v => ({
      index: typeof v.index === 'number' ? v.index : -1,
      verdict: ['accept', 'reject', 'uncertain'].includes(v.verdict) ? v.verdict : 'uncertain',
      reason: String(v.reason || '').slice(0, 200),
    }));
  }

  return {
    reviewer: reviewer.role,
    agentId: reviewer.agentId,
    votes,
    summary: String(parsed.summary || '').slice(0, 1000),
    raw,
    error: null,
  };
}

function tallyVotes(reviews) {
  const tally = {};

  for (const f of FIELDS) {
    tally[f] = [];
  }

  for (const f of FIELDS) {
    const maxIdx = Math.max(0, ...reviews.map(r => {
      const fieldVotes = r.votes?.[f] || [];
      return fieldVotes.reduce((m, v) => Math.max(m, v.index + 1), 0);
    }));

    for (let i = 0; i < maxIdx; i++) {
      const entryVotes = { accept: 0, reject: 0, uncertain: 0, reasons: [] };

      for (const review of reviews) {
        const fieldVotes = review.votes?.[f] || [];
        const vote = fieldVotes.find(v => v.index === i);
        if (vote) {
          entryVotes[vote.verdict]++;
          if (vote.reason) entryVotes.reasons.push({ reviewer: review.reviewer, reason: vote.reason });
        } else {
          entryVotes.uncertain++;
        }
      }

      const verified = entryVotes.accept >= JEV_THRESHOLD;
      const rejected = entryVotes.reject >= JEV_THRESHOLD;

      tally[f].push({
        index: i,
        accept: entryVotes.accept,
        reject: entryVotes.reject,
        uncertain: entryVotes.uncertain,
        verified,
        rejected,
        consensus: verified ? 'verified' : rejected ? 'rejected' : 'disputed',
        reasons: entryVotes.reasons,
      });
    }
  }

  return tally;
}

function applyVerification(ledger, tally) {
  let verified = 0;
  let rejected = 0;

  for (const f of FIELDS) {
    for (const entry of (tally[f] || [])) {
      if (entry.index < ledger[f].length) {
        if (entry.verified) {
          ledger[f][entry.index].verified = true;
          verified++;
        }
        if (entry.rejected && !PROTECTED.has(f)) {
          ledger[f][entry.index].rejected = true;
          rejected++;
        }
      }
    }
  }

  return { verified, rejected };
}

function reviewStats(tally) {
  let totalEntries = 0;
  let verified = 0;
  let rejected = 0;
  let disputed = 0;

  for (const f of FIELDS) {
    for (const entry of (tally[f] || [])) {
      totalEntries++;
      if (entry.consensus === 'verified') verified++;
      else if (entry.consensus === 'rejected') rejected++;
      else disputed++;
    }
  }

  return {
    totalEntries,
    verified,
    rejected,
    disputed,
    verificationRate: totalEntries > 0 ? Math.round((verified / totalEntries) * 100) : 0,
    rejectionRate: totalEntries > 0 ? Math.round((rejected / totalEntries) * 100) : 0,
  };
}

export async function reviewLedger(objective, ledger, config = {}, { broadcast = () => {} } = {}) {
  const panel = REVIEW_PANEL.slice(0, MAX_REVIEWERS);
  const reviews = [];
  const startedAt = Date.now();

  broadcast('chain', { type: 'chain.review_start', reviewers: panel.map(r => r.role) });

  for (const reviewer of panel) {
    broadcast('chain', { type: 'chain.reviewer_start', reviewer: reviewer.role, agentId: reviewer.agentId });

    try {
      const result = await callReviewer(objective, ledger, reviewer, config);
      reviews.push(result);
      broadcast('chain', { type: 'chain.reviewer_complete', reviewer: reviewer.role, hasVotes: !!result.votes, error: result.error });
    } catch (err) {
      reviews.push({
        reviewer: reviewer.role,
        agentId: reviewer.agentId,
        votes: null,
        summary: null,
        raw: null,
        error: `${err.constructor.name}: ${String(err.message).slice(0, 300)}`,
      });
      broadcast('chain', { type: 'chain.reviewer_complete', reviewer: reviewer.role, hasVotes: false, error: err.message });
      console.error(`chain review: ${reviewer.role} failed:`, err.message);
    }
  }

  const validReviews = reviews.filter(r => r.votes);
  const tally = tallyVotes(validReviews);
  const { verified, rejected } = applyVerification(ledger, tally);
  const stats = reviewStats(tally);
  const durationMs = Date.now() - startedAt;

  broadcast('chain', { type: 'chain.review_complete', stats, durationMs });

  return {
    panel: panel.map(r => r.role),
    reviews: reviews.map(r => ({ reviewer: r.reviewer, agentId: r.agentId, summary: r.summary, error: r.error })),
    tally,
    stats,
    applied: { verified, rejected },
    jevThreshold: JEV_THRESHOLD,
    durationMs,
  };
}

export { REVIEW_PANEL, JEV_THRESHOLD, reviewStats, tallyVotes, applyVerification };
