// MCP Tool Definitions — 5 tools for external agent integration
// Source: Creator Nexus MCP tool registrations

export const MCP_TOOLS = {
  openclaw_gateway: {
    name: 'openclaw_gateway',
    description: 'Hub telemetry, OPEG verify, dispatch tasks, fleet manifest, orifice bridge ops',
    handler: 'openclawGateway',
    params: {
      action: { type: 'string', required: true, enum: 'see GATEWAY_ACTIONS' },
      params: { type: 'object', required: false },
    },
  },
  compile_ollama_model: {
    name: 'compile_ollama_model',
    description: 'Deploy custom Ollama models to VPS',
    handler: 'createOllamaModel',
    params: {
      model_name: { type: 'string', required: true },
      modelfile: { type: 'string', required: true },
      target: { type: 'string', default: 'vps' },
    },
  },
  run_argon_evolution: {
    name: 'run_argon_evolution',
    description: 'RSI evolution cycle, consciousness audit, orbital memory',
    handler: 'nexusEvolution',
    params: {
      action: { type: 'string', required: true },
      generation: { type: 'number', required: false },
    },
  },
  build_loosescrew_app: {
    name: 'build_loosescrew_app',
    description: 'Autonomous web app synthesis from prompt',
    handler: 'looseScrewForge',
    params: {
      action: { type: 'string', enum: ['autonomous_build', 'autonomous_evolve', 'push_github'] },
      prompt: { type: 'string' },
      channel: { type: 'string', enum: ['CODE', 'MUSIC', 'VIDEO'] },
    },
  },
  plan_director_scenes: {
    name: 'plan_director_scenes',
    description: 'Script to timed visual scene blueprint',
    handler: 'directorPlan',
    params: {
      narration: { type: 'string', maxLength: 1500 },
      aspect_ratio: { type: 'string', enum: ['9:16', '16:9'] },
    },
  },
};

export const TOOL_NAMES = Object.keys(MCP_TOOLS);

export function getToolDefinition(name) {
  return MCP_TOOLS[name] || null;
}

export function listTools() {
  return Object.values(MCP_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}
