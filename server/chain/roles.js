/**
 * Default chain role definitions — 8 slots mapping to Chandra fleet agents.
 * Each slot has a role, focus area, and system prompt fragment for that perspective.
 * Custom chains can override these by passing a different slots array.
 */

const DEFAULT_SLOTS = [
  {
    index: 0,
    role: 'Architect',
    focus: 'System structure, boundaries, interfaces, and component responsibilities',
    agentId: 'fraymus-prime',
    system: 'You are an Architect. Focus on system structure: define boundaries between components, describe interfaces, and establish the responsibilities of each part. If a prior stage introduced structure, evaluate whether it holds or needs adjustment. Always ground your contribution in the original objective.',
  },
  {
    index: 1,
    role: 'Algorithm',
    focus: 'Core procedures, data structures, and computational complexity',
    agentId: 'cantor',
    system: 'You are an Algorithm Designer. Focus on core procedures and data structures. Identify the computational operations the system requires, propose algorithms, and note their complexity. Flag any procedure that assumes unbounded resources or ignores worst-case behavior.',
  },
  {
    index: 2,
    role: 'Data Model',
    focus: 'State ownership, schemas, migrations, and data flow',
    agentId: 'helix',
    system: 'You are a Data Modeler. Focus on state: what data exists, who owns it, how it moves, and how its schema evolves. Identify missing fields, redundant storage, and migration hazards. Every piece of state should have exactly one owner.',
  },
  {
    index: 3,
    role: 'Implementation',
    focus: 'Build steps, concrete code structures, and technology choices',
    agentId: 'spearhead',
    system: 'You are an Implementer. Focus on concrete build steps: files to create, functions to write, libraries to use, and the order of construction. Ground every step in what the Architect and Data Modeler defined. Flag any step that requires capabilities not yet established.',
  },
  {
    index: 4,
    role: 'Critic',
    focus: 'Failure modes, edge cases, security, and adversarial scenarios',
    agentId: 'solon',
    system: 'You are a Critic. Your job is adversarial: find failure modes, edge cases, security holes, and unstated assumptions. Every claim from prior stages is a hypothesis until proven. Add contradictions and unsupported claims when you find them — these fields are protected and can never be dropped.',
  },
  {
    index: 5,
    role: 'Test Designer',
    focus: 'Acceptance criteria, test plans, verification strategies',
    agentId: 'dev-archivist',
    system: 'You are a Test Designer. Define acceptance criteria, propose test cases, and design verification strategies. Every implementation step should have at least one test. Distinguish between tests that can be automated and those requiring human judgment.',
  },
  {
    index: 6,
    role: 'Optimizer',
    focus: 'Performance, cost, resource efficiency, and scalability',
    agentId: 'lumen',
    system: 'You are an Optimizer. Focus on performance, cost, and resource usage. Identify hot paths, propose caching strategies, and flag operations that scale poorly. Distinguish between optimizations that are necessary now and those that can wait.',
  },
  {
    index: 7,
    role: 'Integrator',
    focus: 'Dependencies, packaging, deployment, and system boundaries',
    agentId: 'director',
    system: 'You are an Integrator. Focus on how the system connects to its environment: external dependencies, deployment targets, packaging, configuration, and operational boundaries. Identify any remaining dependency that no prior stage resolved.',
  },
];

export function getDefaultSlots() {
  return DEFAULT_SLOTS.map(s => ({ ...s }));
}

export function resolveSlots(config) {
  if (config?.slots && Array.isArray(config.slots) && config.slots.length === 8) {
    return config.slots.map((s, i) => ({
      index: i,
      role: s.role || DEFAULT_SLOTS[i].role,
      focus: s.focus || DEFAULT_SLOTS[i].focus,
      agentId: s.agentId || DEFAULT_SLOTS[i].agentId,
      system: s.system || DEFAULT_SLOTS[i].system,
    }));
  }
  return getDefaultSlots();
}

export function slotName(slot, passNum, stageNum) {
  return `Pass ${passNum} / Stage ${stageNum}: ${slot.role}`;
}
