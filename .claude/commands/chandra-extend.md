---
description: "Extend Chandra-FRAYMUS with new agents, pipelines, workflow nodes, or subsystems. The playbook for adding any new capability."
---

# Chandra Extension Skill

## Adding a New Agent

1. Create `agents/your_agent.md` with frontmatter:
```yaml
---
id: your-agent
name: Your Agent
role: What it does in one phrase
tools:
  - tool.name.one
  - tool.name.two
---

System prompt for the agent goes here.
Describe its personality, capabilities, and constraints.
```

2. The manifest loader (`server/fleet/manifest.js`) auto-discovers it on restart
3. Register any new tools the agent needs in the appropriate `tools.js`
4. Test: `curl http://127.0.0.1:8787/api/agents` should show the new agent

## Adding a New Commerce Pipeline

1. Create `server/commerce/your-pipeline.js`:
   - Import `chatOllama`, `shopifyHeaders`, `shopifyBase` from `./shared.js`
   - Export an async function that chains agent calls
   - Use `broadcast('commerce', { type: 'your-pipeline', ... })` for WebSocket updates

2. Add routes in `server/commerce/routes.js`:
   - POST /api/your-pipeline/run — start the pipeline
   - GET /api/your-pipeline/runs — list run history

3. Register tools in `server/commerce/tools.js`:
   - Each stage = one tool
   - Classify: "safe" (local/read) vs "approval_required" (external write)

4. Add workflow nodes in `client/src/panels/WorkflowCanvas.jsx`:
```js
// Add to NODE_TYPES array:
{ type: 'your_node', label: 'Your Node', color: '#hex', icon: 'emoji' },
```

5. Add a pre-built definition in `server/fraymus/workflows/definitions.js`

## Adding a New Workflow Node Type

1. Add to `NODE_TYPES` in `WorkflowCanvas.jsx` (client renders it in sidebar)
2. Add handler in `server/workflow/engine.js` (server executes it)
3. The engine calls your handler with: `{ input, config, context }`
4. Return `{ output, status }` — output flows to connected downstream nodes

## Adding a New Frontend Panel

1. Create `client/src/panels/YourPanel.jsx`:
```jsx
export default function YourPanel({ wsEvent }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/your-endpoint');
      setData(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'your-event') load();
  }, [wsEvent, load]);

  return (/* JSX */);
}
```

2. Add tab in `client/src/App.jsx`:
   - Import the panel
   - Add to the tabs array
   - Pass `wsEvent` prop

3. Server broadcasts: `broadcast('your-event', { ... })` when data changes

## Adding a New FRAYMUS Intelligence Module

1. Create `server/fraymus/intelligence/your-module.js`
2. Accept `entityStore` in constructor for SQLite persistence:
```js
export class YourModule {
  constructor(entityStore) {
    this.store = entityStore;
  }
  async doWork() {
    // Persist via entity store — auto-creates collection
    this.store.YourCollection.create({ data: '...' });
    this.store.YourCollection.filter({ status: 'active' }, { limit: 50 });
  }
}
```
3. Export from `server/fraymus/index.js` (re-export + local aliased import for `createMasterSystem`)
4. Instantiate in `server/fraymus-tools.js` with `entityStore` wired in
5. Add fleet tools in `createFraymusTools()` if externally callable
6. Wire into OpenClaw gateway (`intelligence/openclaw.js`) if it should be a gateway action
7. Test: `node -e "import('./server/fraymus-tools.js').then(m => console.log(m.yourModule))"`

## Adding a Hermes Skill Executor

In `server/fraymus-tools.js`, add to `buildHermesExecutors()`:
```js
your_skill_name: async (params) => {
  // Real implementation — NOT a stub
  const result = await doRealWork(params);
  return { result };
},
```
Then register it: `hermes.registerExecutors(buildHermesExecutors())`

## Adding an OpenClaw Gateway Action

In `server/fraymus/intelligence/openclaw.js`, add to the `GATEWAY_ACTIONS` array and add a case in the `handle()` method:
```js
case 'your_action':
  return { action: 'your_action', result: await this.deps.yourModule.doWork(params) };
```

## Adding a New FRAYMUS Module (non-intelligence)

1. Create `server/fraymus/your-module/your-file.js`
2. Export functions following ESM pattern
3. Wire into `server/fraymus/index.js` if it needs initialization
4. Add MCP tools in `server/fraymus/mcp/tools.js` if externally callable
5. Add entity schemas in `server/fraymus/entities/schemas.js` if it defines data structures

## Adding an Encoding Format

1. Create `server/fraymus/encoding/your-format.js`
2. Export `encode(data)` and `decode(encoded)` functions
3. Register in `server/fraymus/encoding/forms.js`

## Adding a Fleet Tool

In the appropriate `tools.js`:
```js
{
  name: 'category.tool_name',
  description: 'What it does',
  safety: 'safe', // or 'approval_required'
  parameters: { /* JSON schema */ },
  handler: async (params, context) => {
    // Implementation
    return { result: '...' };
  }
}
```

## Verification After Extension

1. `node --check` on every changed/new server file
2. `curl http://127.0.0.1:8787/api/health` — feature count should increase
3. Open http://127.0.0.1:5173 — new panel/node should appear
4. Test the golden path end to end
5. Commit and push to origin/master
