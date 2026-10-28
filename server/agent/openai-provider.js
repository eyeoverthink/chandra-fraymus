import { AgentError, fail } from './schema.js';
import { readJson } from './provider.js';

// No environment/key lookup, model guessing, dynamic pricing, remote endpoint override, or retries.
export function createOpenAIProvider({ config, fetchImpl = fetch }) {
  if (config?.enabled !== true) fail('cloud_disabled', 'OpenAI cloud inference is disabled');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || /\s/.test(config.apiKey) || config.apiKey.length > 4096) fail('cloud_config', 'Cloud inference requires a server-owned API key');
  const ceiling = config.maxRunCostUsd ?? 1;
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 100) fail('cloud_config', 'Cloud maxRunCostUsd must be greater than zero and at most 100');
  if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models) || !Object.keys(config.models).length || Object.keys(config.models).length > 30) fail('cloud_config', 'Cloud inference requires an explicit priced model allowlist');
  const models = new Map();
  for (const [name, entry] of Object.entries(config.models)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(name) || !entry || ![entry.inputUsdPerMillion, entry.outputUsdPerMillion].every(rate => Number.isFinite(rate) && rate > 0 && rate <= 1000000) || (entry.tools !== undefined && typeof entry.tools !== 'boolean') || (entry.vision !== undefined && typeof entry.vision !== 'boolean')) fail('cloud_pricing_unknown', 'Every allowed cloud model needs explicit positive input/output USD-per-million rates and capability flags');
    models.set(name, Object.freeze({ name, provider: 'openai', local: false, cloud: true, allowed: true, tools: entry.tools === true, vision: entry.vision === true, capabilities: Object.freeze(['completion', ...(entry.tools ? ['tools'] : []), ...(entry.vision ? ['vision'] : [])]), rates: Object.freeze({ inputUsdPerMillion: entry.inputUsdPerMillion, outputUsdPerMillion: entry.outputUsdPerMillion }), pricingSource: 'server_configuration' }));
  }
  const metadata = model => { const value = models.get(model); if (!value) fail('cloud_model_not_allowed', 'Cloud model is absent from the server priced allowlist'); return value; };
  async function request(endpoint, body, signal) {
    signal.throwIfAborted();
    let response;
    try { response = await fetchImpl(`https://api.openai.com/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body), signal, redirect: 'error' }); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      // Do not include arbitrary fetch errors: they may echo authorization headers.
      throw new AgentError('cloud_transport', 'OpenAI transport failed; any reserved inference cost remains uncertain');
    }
    return readJson(response, signal);
  }
  function prepare({ model, messages, tools }) {
    const info = metadata(model);
    const aliases = new Map(), reverse = new Map();
    const functions = (tools || []).map((tool, index) => {
      const alias = `tool_${index}`;
      aliases.set(tool.function.name, alias); reverse.set(alias, tool.function.name);
      return { type: 'function', name: alias, description: `${tool.function.name}: ${tool.function.description}`, parameters: tool.function.parameters, strict: false };
    });
    if (functions.length && !info.tools) fail('model_tools_unsupported', 'Configured cloud model does not enable tools');
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const input = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.providerOutput) {
        input.push(...message.providerOutput); continue;
      }
      if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }); continue; }
      if (message.tool_calls?.length) {
        if (message.content) input.push({ role: 'assistant', content: message.content });
        for (const call of message.tool_calls) input.push({ type: 'function_call', call_id: call.id, name: aliases.get(call.function.name), arguments: JSON.stringify(call.function.arguments) });
        continue;
      }
      // Persisted completed turns are EasyInputMessage values, not full output
      // items. output_text arrays require ResponseOutputMessage IDs/status/etc.
      if (message.role === 'assistant') { input.push({ role: 'assistant', content: message.content, phase: 'final_answer' }); continue; }
      const content = [{ type: 'input_text', text: message.content }];
      for (const image of message.images || []) {
        if (!info.vision) fail('model_vision_unsupported', 'Configured cloud model does not enable vision');
        const bytes = Buffer.from(image, 'base64');
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
        if (!mime) fail('invalid_attachments', 'Cloud image input must be validated PNG, JPEG or WebP');
        content.push({ type: 'input_image', image_url: `data:${mime};base64,${image}`, detail: 'auto' });
      }
      input.push({ role: message.role, content });
    }
    return { body: { model, instructions, input, parallel_tool_calls: false, ...(functions.length ? { tools: functions } : {}) }, info, reverse };
  }
  return {
    id: 'openai', local: false, minOutputTokens: 16, maxRunCostUsd: ceiling,
    listModels: async () => [...models.values()], inspectModel: async model => metadata(model), getModelInfo: metadata,
    async chat({ model, messages, tools, maxOutputTokens, maxInputTokens, remainingTotalTokens, remainingCostUsd, beforeRequest, allowCloud, signal }) {
      if (allowCloud !== true) fail('cloud_opt_in_required', 'Cloud inference requires explicit per-run allowCloud:true');
      const { body, info, reverse } = prepare({ model, messages, tools });
      if (!Number.isFinite(remainingCostUsd) || remainingCostUsd <= 0 || remainingCostUsd > ceiling || maxOutputTokens < 16) fail('cloud_budget', 'Cloud inference requires a positive budget and at least 16 output tokens');
      const count = await request('responses/input_tokens', body, signal);
      if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0) fail('cloud_token_count', 'Cloud input token count is unavailable; inference was not requested');
      if (count.input_tokens > maxInputTokens) fail('budget_context', 'Cloud input token count exceeds maxInputTokens; inference was not requested');
      const rates = info.rates;
      const inputCost = count.input_tokens * rates.inputUsdPerMillion / 1000000;
      const allowedByCost = Math.floor((remainingCostUsd - inputCost) * 1000000 / rates.outputUsdPerMillion);
      const limit = Math.min(maxOutputTokens, remainingTotalTokens - count.input_tokens, allowedByCost);
      if (!Number.isSafeInteger(limit) || limit < 16) fail('cloud_budget', 'Worst-case inference reservation exceeds remaining cost/token budget; inference was not requested');
      const reservedCostUsd = inputCost + limit * rates.outputUsdPerMillion / 1000000;
      await beforeRequest?.({ reservedCostUsd, inputTokens: count.input_tokens, maxOutputTokens: limit, rates });
      signal.throwIfAborted();
      const data = await request('responses', { ...body, max_output_tokens: limit, store: false, truncation: 'disabled', parallel_tool_calls: false, include: ['reasoning.encrypted_content'] }, signal);
      if (!data.usage || ![data.usage.input_tokens, data.usage.output_tokens].every(number => Number.isSafeInteger(number) && number >= 0)) fail('usage_unavailable', 'Cloud response omitted actual usage; reserved cost remains uncertain');
      const usage = { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, costUsd: (data.usage.input_tokens * rates.inputUsdPerMillion + data.usage.output_tokens * rates.outputUsdPerMillion) / 1000000 };
      if (!Array.isArray(data.output)) fail('provider_invalid_response', 'Cloud response output is invalid; reserved cost remains uncertain');
      let content = ''; const calls = [];
      for (const item of data.output) {
        if (item.type === 'message') for (const part of item.content || []) {
          if (part.type === 'output_text' && typeof part.text === 'string') content += part.text;
          else if (part.type === 'refusal' && typeof part.refusal === 'string') content += part.refusal;
          else fail('provider_invalid_response', 'Unsupported cloud message output');
        }
        else if (item.type === 'function_call') {
          const name = reverse.get(item.name);
          if (!name || typeof item.call_id !== 'string' || item.call_id.length > 200 || typeof item.arguments !== 'string') fail('invalid_tool_call', 'Cloud response returned an unknown or malformed function call');
          calls.push({ id: item.call_id, function: { name, arguments: item.arguments } });
        } else if (item.type !== 'reasoning') fail('provider_invalid_response', 'Unexpected cloud output type');
      }
      const providerError = data.error?.message || (!['completed', 'incomplete'].includes(data.status) ? `Unexpected cloud response status ${data.status}` : undefined);
      return { message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}), providerOutput: data.output }, usage, finishReason: data.status === 'incomplete' ? 'length' : 'stop', ...(providerError ? { providerError } : {}) };
    },
  };
}
