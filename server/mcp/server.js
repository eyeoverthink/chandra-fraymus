import { verifyBearer, can } from './auth.js';
import {
  listAgents, getAgent, saveAgentManifest, resetAgentManifest,
  listThreads, getThread, decideApproval, runAgentAndWait, callToolDirect,
} from '../fleet/runtime.js';
import { listAutomations, saveAutomation, deleteAutomation, runAutomation, automationRuns } from '../automations/scheduler.js';
import { mcpServers, importServers, removeServer } from './client.js';

const out = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function buildToolHandlers(principal) {
  const uid = principal.userId;
  const guard = (scope, fn) => async (args) => {
    if (!can(principal, scope)) return { isError: true, ...out(`Token lacks the "${scope}" scope`) };
    try { return out(await fn(args)); } catch (e) { return { isError: true, ...out(e?.message || String(e)) }; }
  };

  return {
    list_agents: { scope: 'read', description: 'List all agents', schema: {}, handler: guard('read', () => listAgents(uid).map(({ systemPrompt, ...a }) => a)) },
    get_agent: { scope: 'read', description: 'Get one agent including system prompt', schema: { id: 'string' }, handler: guard('read', ({ id }) => getAgent(uid, id) || (() => { throw new Error('unknown agent'); })()) },
    upsert_agent: { scope: 'admin', description: 'Create or change an agent manifest', schema: { id: 'string', name: 'string', systemPrompt: 'string' }, handler: guard('admin', a => saveAgentManifest(a)) },
    reset_agent: { scope: 'admin', description: 'Delete runtime override, restore default', schema: { id: 'string' }, handler: guard('admin', ({ id }) => ({ removed: resetAgentManifest(id) })) },
    run_agent: { scope: 'run', description: 'Send a message to an agent and wait for reply', schema: { agentId: 'string', message: 'string' }, handler: guard('run', a => runAgentAndWait(uid, a.agentId, a.message, a.threadId, (a.waitSeconds || 120) * 1000)) },
    list_threads: { scope: 'read', description: 'List recent conversations', schema: {}, handler: guard('read', () => listThreads(uid)) },
    get_thread: { scope: 'read', description: 'Get a conversation with messages', schema: { id: 'string' }, handler: guard('read', ({ id }) => { const t = getThread(uid, id); if (!t) throw new Error('thread not found'); return t; }) },
    decide_approval: { scope: 'admin', description: 'Approve or reject a pending tool call', schema: { approvalId: 'string', approve: 'boolean' }, handler: guard('admin', ({ approvalId, approve }) => decideApproval(uid, approvalId, approve)) },
    call_tool: { scope: 'admin', description: 'Execute any registered tool directly', schema: { name: 'string', arguments: 'object' }, handler: guard('admin', ({ name, arguments: args }) => callToolDirect(uid, name, args)) },
    list_mcp_servers: { scope: 'read', description: 'List connected MCP servers', schema: {}, handler: guard('read', () => mcpServers()) },
    import_mcp_server: { scope: 'admin', description: 'Connect another MCP server', schema: { name: 'string', url: 'string' }, handler: guard('admin', a => importServers(a)) },
    remove_mcp_server: { scope: 'admin', description: 'Disconnect an imported MCP server', schema: { name: 'string' }, handler: guard('admin', async ({ name }) => ({ removed: await removeServer(name) })) },
    list_automations: { scope: 'read', description: 'List scheduled automations', schema: {}, handler: guard('read', () => listAutomations(uid)) },
    upsert_automation: { scope: 'admin', description: 'Create/update a scheduled automation', schema: { name: 'string', cron: 'string' }, handler: guard('admin', a => saveAutomation(uid, a)) },
    run_automation: { scope: 'admin', description: 'Run an automation now', schema: { id: 'string' }, handler: guard('admin', ({ id }) => runAutomation(uid, id, 'manual')) },
    automation_runs: { scope: 'read', description: 'Recent run history of an automation', schema: { id: 'string' }, handler: guard('read', ({ id }) => automationRuns(uid, id)) },
    delete_automation: { scope: 'admin', description: 'Delete an automation', schema: { id: 'string' }, handler: guard('admin', ({ id }) => ({ removed: deleteAutomation(uid, id) })) },
  };
}

export function installMcpEndpoint(app) {
  const issuer = req => process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;

  app.post('/mcp', async (req, res) => {
    const principal = verifyBearer(req.headers.authorization);
    if (!principal) {
      return res.status(401)
        .setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer(req)}/.well-known/oauth-protected-resource"`)
        .json({ error: 'unauthorized' });
    }

    const body = req.body;
    if (!body || body.jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid JSON-RPC' }, id: body?.id || null });
    }

    const handlers = buildToolHandlers(principal);

    try {
      if (body.method === 'initialize') {
        return res.json({
          jsonrpc: '2.0', id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'chandra-fraymus', version: '1.0.0' },
            capabilities: { tools: { listChanged: false } },
          },
        });
      }

      if (body.method === 'tools/list') {
        const tools = Object.entries(handlers).map(([name, h]) => ({
          name, description: `${h.description} [scope: ${h.scope}]`,
          inputSchema: { type: 'object', properties: {} },
        }));
        return res.json({ jsonrpc: '2.0', id: body.id, result: { tools } });
      }

      if (body.method === 'tools/call') {
        const { name, arguments: args } = body.params || {};
        const handler = handlers[name];
        if (!handler) {
          return res.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, ...out(`Unknown tool: ${name}`) } });
        }
        const result = await handler.handler(args || {});
        return res.json({ jsonrpc: '2.0', id: body.id, result });
      }

      if (body.method === 'notifications/initialized') {
        return res.status(204).end();
      }

      return res.json({
        jsonrpc: '2.0', id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
      });
    } catch (e) {
      return res.json({
        jsonrpc: '2.0', id: body.id,
        error: { code: -32603, message: e?.message || 'Internal error' },
      });
    }
  });
}
