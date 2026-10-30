import { createHash } from 'node:crypto';

export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}
export const fail = (code, message) => { throw new AgentError(code, message); };
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export function assertSchema(value, schema, location = 'arguments') {
  const type = schema.type;
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type;
  if (!valid) fail('invalid_arguments', `${location} must be ${type}`);
  if (schema.enum && !schema.enum.includes(value)) fail('invalid_arguments', `${location} has an unsupported value`);
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail('invalid_arguments', `${location}.${key} is required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) fail('invalid_arguments', `${location}.${key} is not allowed`);
      assertSchema(value[key], schema.properties[key], `${location}.${key}`);
    }
  } else if (type === 'array') {
    if (value.length > (schema.maxItems ?? 100)) fail('invalid_arguments', `${location} is too long`);
    if (value.length < (schema.minItems ?? 0)) fail('invalid_arguments', `${location} is too short`);
    value.forEach((item, i) => assertSchema(item, schema.items, `${location}[${i}]`));
  } else if (type === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 65536)) fail('invalid_arguments', `${location} has invalid length`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('invalid_arguments', `${location} has invalid format`);
  } else if (type === 'integer' || type === 'number') {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('invalid_arguments', `${location} is out of bounds`);
  }
  return value;
}

// Deliberately a small JSON Schema subset. Unsupported constraints fail closed at registration.
export function checkSchema(schema, depth = 0) {
  if (!schema || depth > 8 || !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) fail('invalid_tool', 'Unsupported tool parameter schema');
  const allowed = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'enum', 'default']);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) fail('invalid_tool', `Unsupported schema constraint: ${key}`);
  if (schema.type === 'object') {
    if (schema.additionalProperties === true) fail('invalid_tool', 'Tool schemas must have fixed properties');
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid_tool', 'Unsafe schema property');
      checkSchema(sub, depth + 1);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(schema.properties || {}, key)) fail('invalid_tool', 'Required property lacks a schema');
  }
  if (schema.type === 'array') checkSchema(schema.items, depth + 1);
  if (schema.pattern) { try { new RegExp(schema.pattern); } catch { fail('invalid_tool', 'Invalid schema pattern'); } }
}

export function boundedResult(value, limit) {
  let serialized;
  try { serialized = JSON.stringify(value === undefined ? null : value); } catch { fail('invalid_tool_result', 'Tool returned non-JSON data'); }
  if (serialized.length <= limit) return { value: JSON.parse(serialized), text: serialized };
  const wrapper = { truncated: true, originalChars: serialized.length, preview: '' };
  const overhead = JSON.stringify(wrapper).length;
  // Escapes can expand sixfold. Search for a preview whose complete JSON stays bounded.
  let low = 0, high = Math.max(0, limit - overhead);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    wrapper.preview = serialized.slice(0, middle);
    if (JSON.stringify(wrapper).length <= limit) low = middle; else high = middle - 1;
  }
  wrapper.preview = serialized.slice(0, low);
  return { value: wrapper, text: JSON.stringify(wrapper) };
}
