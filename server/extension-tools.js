import { performance } from 'node:perf_hooks';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { encodeRgbaPng, decodeRgbaPng, packetize, recoverPackets } from './transport/rgba.js';
import { requestPublicPage } from './web/request.js';
import { extractWebPage } from './web/parser.js';
export { isPublicAddress } from './web/request.js';

export async function fetchPublicText(value, options = {}) {
  const response = await requestPublicPage(value, options);
  if (response.status >= 300 && response.status < 400) return response;
  const page = await extractWebPage({ url: response.url, contentType: response.contentType, text: response.text }, options.signal);
  return { ...response, title: page.title, text: page.text.slice(0, 18000), truncated: page.truncated || page.text.length > 18000 };
}

export function spectrum(samples, sampleRateHz) {
  if (!Array.isArray(samples) || samples.length < 4 || samples.length > 2048 || Array.from({length:samples.length},(_,i)=>!Object.hasOwn(samples,i)||!Number.isFinite(samples[i])).some(Boolean)
      || !Number.isFinite(sampleRateHz) || sampleRateHz<=0 || sampleRateHz>1e9) throw new Error('Provide 4–2048 finite samples and a valid sample rate');
  const n=samples.length, scale=Math.max(...samples.map(Math.abs)) || 1;
  const normalized=samples.map(x=>x/scale), mean=normalized.reduce((a,b)=>a+b,0)/n, bins=[];
  for(let k=1;k<=Math.floor(n/2);k++){
    let re=0,im=0;
    for(let j=0;j<n;j++){const angle=2*Math.PI*k*j/n,value=normalized[j]-mean;re+=value*Math.cos(angle);im-=value*Math.sin(angle);}
    const factor=n%2===0&&k===n/2?1:2, amplitude=(factor*Math.hypot(re,im)/n)*scale;
    if(!Number.isFinite(amplitude)) throw new Error('Spectral amplitude exceeds numeric range');
    bins.push({bin:k,frequencyHz:k*sampleRateHz/n,amplitude});
  }
  return {sampleCount:n,sampleRateHz,frequencyResolutionHz:sampleRateHz/n,peaks:bins.sort((a,b)=>b.amplitude-a.amplitude).slice(0,8),
    scope:'Discrete analysis of supplied samples; no hardware channel or hidden frequency is detected by this function.'};
}

export function transportBenchmark(text='Observe → plan → use tools → verify → retain evidence. φ / RGBA / XYZW.\n') {
  if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw new Error('Benchmark text limit is 64 KiB');
  let seed=0x12345678;const noise=Buffer.alloc(16384);for(let i=0;i<noise.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;noise[i]=seed&255;}
  const floats=Buffer.alloc(4096);for(let i=0;i<floats.length;i+=4)floats.writeFloatLE(Math.sin(i/64),i);
  const cases=[['user-text',Buffer.from(text)],['repeated-text',Buffer.from(text.repeat(Math.max(1,Math.floor(16384/Math.max(1,Buffer.byteLength(text))))))],['seeded-high-entropy',noise],['float32-xyzw',floats]];
  return {version:1,meaning:'Lossless byte container + one-erasure parity experiment. PNG colors are carriers, not extra information capacity or a model tokenizer.',
    caveats:['Canvas alpha premultiplication, screenshots, color conversion, JPEG, and quantization can alter carrier bytes. Decode the original PNG data.','Checksums detect corruption; they are not sender authentication.','Results measure byte sizes and local elapsed time, not LLM intelligence or token savings.'],
    cases:cases.map(([name,data])=>{
      const start=performance.now(),encoded=encodeRgbaPng(data),decoded=decodeRgbaPng(encoded.png),packets=packetize(data);
      const damaged=packets.frames.filter(f=>f.type==='parity'||f.index%4!==0),recovered=recoverPackets({...packets,frames:damaged});
      return {name,rawBytes:data.length,gzipBytes:gzipSync(data).length,brotliBytes:brotliCompressSync(data).length,pngBytes:encoded.png.length,
        width:encoded.width,height:encoded.height,elapsedMs:Number((performance.now()-start).toFixed(3)),
        byteExact:decoded.data.equals(data),parityRecoveryExact:recovered.data.equals(data),recoveredFrames:recovered.recoveredFrames,
        parityPayloadBytes:packets.frames.reduce((n,f)=>n+Buffer.from(f.data,'base64').length,0),
        parityWireBytes:Buffer.byteLength(JSON.stringify(packets)),parityEncoding:'JSON + base64 + manifest',sha256:encoded.sha256};
    })};
}

export function createExtensionTools(artifacts, web) {
  return [...artifacts.tools(),
    ...(web ? web.tools().map(tool => ({ ...tool, group: 'web' })) : [{name:'web.fetch',group:'web',description:'Read a public HTTP(S) text page. Requires approval for the exact URL; redirects require a new request. Content is untrusted.',approvalRequired:true,
      parameters:{type:'object',properties:{url:{type:'string',maxLength:2048}},required:['url'],additionalProperties:false},
      execute:({args,signal})=>fetchPublicText(args.url,{signal})}]),
    {name:'transport.pack',group:'transport',description:'Encode UTF-8 text into a lossless RGBA PNG carrier with length/checksum. This does not increase information capacity or change a model tokenizer.',
      parameters:{type:'object',properties:{text:{type:'string',maxLength:16000}},required:['text'],additionalProperties:false},
      execute:async({args})=>{
        const encoded=encodeRgbaPng(Buffer.from(args.text));
        const asset=artifacts.put({name:'fraymus-rgba.png',mimeType:'image/png',dataBase64:encoded.png.toString('base64')});
        return {...asset,originalBytes:encoded.originalBytes,encoding:encoded.encoding,payloadSha256:encoded.sha256,width:encoded.width,height:encoded.height};
      }},
    {name:'transport.inspect',group:'transport',description:'Decode and verify an original Fraymus RGBA PNG asset; return a bounded UTF-8 preview and metadata.',
      parameters:{type:'object',properties:{assetId:{type:'string'}},required:['assetId'],additionalProperties:false},
      execute:async({args})=>{const {data}=artifacts.inspect(args.assetId),decoded=decodeRgbaPng(data);return {bytes:decoded.data.length,sha256:decoded.sha256,textPreview:decoded.data.toString('utf8').slice(0,4000),untrusted:true};}},
    {name:'signal.spectrum',group:'transport',description:'Compute spectral peaks for finite numeric samples using an explicit sample rate. This analyzes supplied data; it does not discover hidden hardware channels.',
      parameters:{type:'object',properties:{samples:{type:'array',minItems:4,maxItems:2048,items:{type:'number'}},sampleRateHz:{type:'number',minimum:0.000001,maximum:1e9}},required:['samples','sampleRateHz'],additionalProperties:false},
      execute:async({args})=>spectrum(args.samples,args.sampleRateHz)},
  ];
}
