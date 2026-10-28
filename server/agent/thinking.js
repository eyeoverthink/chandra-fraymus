import {fail} from './schema.js';

const valid=value=>typeof value==='boolean'||typeof value==='string'&&value.length>0&&value.length<=64&&value.isWellFormed()&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const privateThinking=new WeakMap();

/** Omission and null mean the model's existing default, never an injected value. */
export function normalizeThinking(value) {
  if(value===undefined||value===null)return undefined;
  if(!valid(value))fail('invalid_thinking','thinking must be an advertised boolean or exact named string, or omitted for the model default');
  return value;
}

/** Only expose a small well-formed control set; capability labels alone are not evidence. */
export function thinkingControls(metadata) {
  const input=metadata?.thinking;
  if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.values)||input.values.length<1||input.values.length>16||!input.values.every(valid))return undefined;
  const values=[...new Set(input.values)];
  if(Object.hasOwn(input,'default')&&!values.some(value=>Object.is(value,input.default)))return undefined;
  const result={values,...(Object.hasOwn(input,'default')?{default:input.default}:{})};
  if(JSON.stringify(result).length>1200)return undefined;
  return result;
}

export function requireThinking(value,metadata) {
  const selected=normalizeThinking(value);
  if(selected===undefined)return;
  if(!Array.isArray(metadata?.thinking?.values)||!metadata.thinking.values.some(option=>Object.is(option,selected)))fail('thinking_unsupported','This model does not currently advertise the exact requested thinking setting; refresh its controls or choose Model default');
}

// The model's private continuation is deliberately absent from enumerable
// provider results, public run/event records and saved conversation history.
export function attachPrivateThinking(response,text) {
  if(text===undefined||text==='')return;
  if(typeof text!=='string'||!text.isWellFormed()||text.length>32768||Buffer.byteLength(text)>65536) {
    response.providerError='Local reasoning continuation is malformed or exceeds its private context limit; no tool effect will execute';return;
  }
  privateThinking.set(response,text);
}
export function consumePrivateThinking(response) {
  const text=privateThinking.get(response);privateThinking.delete(response);return text;
}
