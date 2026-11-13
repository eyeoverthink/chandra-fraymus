/**
 * Fleet tools for Logic Chain — allows agents to trigger and query chain runs.
 */

import { startChain, loadRun, listRuns, renderDocument, saveRun } from './engine.js';
import { ledgerStats } from './ledger.js';
import { reviewLedger } from './review.js';

export function createChainTools({ broadcast, memoryBridge } = {}) {
  return [
    {
      name: 'chain.run',
      description: 'Start a Logic Chain run: 8 specialized agents analyze an objective across 2 passes (16 stages), accumulating evidence in a structured ledger. Returns the run id at once; the chain takes many minutes — read it later with chain.status and chain.document.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The objective to analyze' },
          model: { type: 'string', description: 'Ollama model to use (optional)' },
        },
        required: ['objective'],
      },
      handler: async (params) => {
        const run = await startChain(params.objective, { model: params.model }, { broadcast, memoryBridge });
        return { id: run.id, status: run.status, note: 'Started. The chain runs in the background; check it with chain.status.' };
      },
    },
    {
      name: 'chain.status',
      description: 'Get the status and ledger stats of a chain run.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Chain run ID' },
        },
        required: ['runId'],
      },
      handler: async (params) => {
        const run = loadRun(params.runId);
        if (!run) return { error: 'Run not found' };
        return { id: run.id, status: run.status, stages: run.stages.length, ledger: ledgerStats(run.ledger), stopReason: run.stopReason };
      },
    },
    {
      name: 'chain.document',
      description: 'Get the synthesis document from a completed chain run.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Chain run ID' },
        },
        required: ['runId'],
      },
      handler: async (params) => {
        const run = loadRun(params.runId);
        if (!run) return { error: 'Run not found' };
        return { document: renderDocument(run) };
      },
    },
    {
      name: 'chain.list_runs',
      description: 'List recent Logic Chain runs.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max runs to return (default 20)' },
        },
      },
      handler: async (params) => {
        return { runs: listRuns(params.limit || 20) };
      },
    },
    {
      name: 'chain.review',
      description: 'Trigger a multi-agent review on a completed chain run. A panel of 3 reviewers (Critic, Test Designer, Architect) votes on every ledger entry using JEV 2-of-3 agreement.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Chain run ID to review' },
        },
        required: ['runId'],
      },
      handler: async (params) => {
        const run = loadRun(params.runId);
        if (!run) return { error: 'Run not found' };
        if (run.status === 'running') return { error: 'Cannot review a running chain' };
        const review = await reviewLedger(run.objective, run.ledger, run.config || {}, { broadcast });
        run.review = review;
        saveRun(run);
        return { runId: run.id, stats: review.stats, applied: review.applied, durationMs: review.durationMs };
      },
    },
    {
      name: 'chain.review_status',
      description: 'Get the review results for a chain run — vote tallies, verification stats, and reviewer summaries.',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Chain run ID' },
        },
        required: ['runId'],
      },
      handler: async (params) => {
        const run = loadRun(params.runId);
        if (!run) return { error: 'Run not found' };
        if (!run.review) return { error: 'No review data — review has not been run yet' };
        return { runId: run.id, review: run.review };
      },
    },
  ];
}
