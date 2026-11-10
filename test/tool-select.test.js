import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, selectToolsForRun } from '../server/fleet/tool-select.js';

const mk = (name, description = '', extra = {}) => ({ name, description, ...extra });
const many = Array.from({ length: 60 }, (_, i) => mk('filler_' + i, 'does nothing in particular'));
const tools = [...many.slice(0, 30), mk('bus_publish', 'publish a message to a bus topic'), mk('shopify.create_product', 'create a product in the store', { safety: 'approval_required' }),
  mk('reason', 'deliberate reasoner for hard problems', { group: 'skill', forAllAgents: true }), mk('memory_search', 'search stored memories'), ...many.slice(30)];

test('approval labels are honoured in every spelling', () => {
  assert.equal(needsApproval({ risk: 'approval' }), true);
  assert.equal(needsApproval({ risk: 'approval_required' }), true);
  assert.equal(needsApproval({ safety: 'approval_required' }), true);
  assert.equal(needsApproval({ risk: 'safe' }), false);
  assert.equal(needsApproval({ risk: 'medium' }), false);
  assert.equal(needsApproval(null), false);
});

test('a small tool list is returned untouched', () => {
  const few = tools.slice(0, 5);
  assert.equal(selectToolsForRun(few, 'anything', { max: 24 }), few);
});

test('the task picks the relevant tools and the cap holds', () => {
  const picked = selectToolsForRun(tools, 'Publish a message to the bus about the new product', { max: 8 });
  assert.equal(picked.length, 8);
  const names = picked.map(t => t.name);
  assert.ok(names.includes('bus_publish'));
  assert.ok(names.includes('shopify.create_product'));
  assert.ok(names.includes('reason'), 'for-all-agents skill tools stay in reach');
});

test('a tool named outright always makes the cut; pinned tools beat fillers', () => {
  assert.ok(selectToolsForRun(tools, 'call memory_search for the pi roster', { max: 4 }).some(t => t.name === 'memory_search'));
  assert.ok(selectToolsForRun(tools, 'unrelated words entirely', { max: 4, pinned: ['filler_55'] }).some(t => t.name === 'filler_55'));
});

test('selection is deterministic and keeps registry order', () => {
  const a = selectToolsForRun(tools, 'search memories', { max: 6 }).map(t => t.name);
  const b = selectToolsForRun(tools, 'search memories', { max: 6 }).map(t => t.name);
  assert.deepEqual(a, b);
  const idx = a.map(n => tools.findIndex(t => t.name === n));
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
});
