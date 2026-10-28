import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateImage} from '../image-validation.js';

const ROOT=fileURLToPath(new URL('.',import.meta.url));
const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PY=path.win32.join(process.env.LOCALAPPDATA??'C:\\Unavailable','Programs','Python','Python312','python.exe');
const MEMORY=512*1024*1024,OUTPUT=256*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message,resource)=>Object.assign(new Error(message),{code,...(resource?{resource}: {})});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const text=value=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\0');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const ERRORS=new Set(['ocr_unavailable','ocr_invalid_request','ocr_invalid_base64','ocr_invalid_image','ocr_input_limit','ocr_image_limit','ocr_dimension_mismatch','ocr_output_limit','ocr_timeout','ocr_cancelled','ocr_process_failed','ocr_job_unavailable','ocr_async_unavailable','ocr_native_failed','ocr_language_limit']);

function cleanupProof(value) {
  const allowed=['memoryBytes','activeProcessLimit','killOnJobClose','jobVerifiedBeforeResume','notCreated','childExited','activeProcesses','stdioDrained','jobClosed','cleanupConfirmed','childPid','exitCode','elapsedMs'];
  if(!keys(value,allowed)||value.memoryBytes!==MEMORY||value.activeProcessLimit!==1||value.killOnJobClose!==true
      ||!['jobVerifiedBeforeResume','notCreated','childExited','stdioDrained','jobClosed','cleanupConfirmed'].every(key=>typeof value[key]==='boolean')
      ||!(value.activeProcesses===null||integer(value.activeProcesses,1))||!integer(value.elapsedMs,60000)
      ||value.childPid!==undefined&&(!integer(value.childPid,0xffffffff)||value.childPid===0)
      ||value.exitCode!==undefined&&!integer(value.exitCode,0xffffffff))throw fail('ocr_receipt_invalid','OCR resource receipt is invalid');
  const confirmed=value.childExited&&value.activeProcesses===0&&value.stdioDrained&&value.jobClosed;
  if(value.cleanupConfirmed!==confirmed||value.notCreated&&(value.childPid!==undefined||value.jobVerifiedBeforeResume)
      ||!value.notCreated&&value.childPid===undefined)throw fail('ocr_receipt_invalid','OCR resource cleanup facts contradict each other');
  return freeze(JSON.parse(JSON.stringify(value)));
}
function nativeHealth(native) {
  const allowed=['ok','engine','languages','maxImageDimension','osBuild','accuracyVerified','requiresReview','confidenceAvailable','available','code','language','text','lines','wordCount','textBytes','width','height','imageSha256','orientation'];
  if(!keys(native,allowed)||native.engine!=='windows-media-ocr'||!Array.isArray(native.languages)||native.languages.length>128
      ||native.languages.some(value=>typeof value!=='string'||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value))
      ||!integer(native.maxImageDimension,65536)||native.maxImageDimension<1||!integer(native.osBuild,1000000)||native.osBuild<10240
      ||typeof native.available!=='boolean'||native.accuracyVerified!==false||native.requiresReview!==true||native.confidenceAvailable!==false
      ||native.available&&!native.languages.includes('en-US'))throw fail('ocr_receipt_invalid','OCR engine metadata is invalid');
  return native;
}

/** Local fixed-helper OCR only. Process/fs seams are trusted constructor inputs,
 * never model/tool parameters. No native process is launched by construction. */
export function createNativeOcr({pythonPath=PY,spawnImpl=spawn,readFileImpl=readFile,statImpl=stat,
  platform=process.platform,deadlineMs=15000,cleanupGraceMs=2000,maxConcurrent=2}={}) {
  if(typeof pythonPath!=='string'||!path.win32.isAbsolute(pythonPath)||pythonPath.includes('\0'))throw new TypeError('OCR Python must be an absolute trusted executable path');
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>2||!Number.isInteger(deadlineMs)||deadlineMs<50||deadlineMs>15000
     ||!Number.isInteger(cleanupGraceMs)||cleanupGraceMs<20||cleanupGraceMs>2000)throw new TypeError('Invalid bounded OCR process configuration');
  const helper=path.join(ROOT,'windows-ocr.ps1'),launcher=path.join(ROOT,'bounded-ocr.py'),definitions=path.resolve(ROOT,'../documents/bounded-process.py');
  let identityPromise,active=0,closing=false,quarantined=false;
  const queue=[],controllers=new Set(),pending=new Set(),orphans=new Set();
  const identity=()=>identityPromise??=(async()=>{
    for(const binary of [pythonPath,PS])if(!(await statImpl(binary)).isFile())throw fail('ocr_unavailable','Installed Windows OCR runtimes are unavailable');
    const [workerBytes,launcherBytes,definitionBytes]=await Promise.all([helper,launcher,definitions].map(file=>readFileImpl(file)));
    return freeze({helperSha256:sha(workerBytes),launcherSha256:sha(launcherBytes),jobDefinitionsSha256:sha(definitionBytes)});
  })();
  const acquire=signal=>{
    signal.throwIfAborted();
    if(active<maxConcurrent){active++;return Promise.resolve();}
    if(queue.length>=16)throw fail('ocr_busy','The local OCR queue is full');
    return new Promise((resolve,reject)=>{
      const entry={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});queue.push(entry);
    });
  };
  function release(){const entry=queue.shift();if(entry)entry.resolve();else active--;}
  async function worker(request,signal,expected) {
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      let child,closed=false,finished=false,forced=false,failureReason,grace,finalTimer,spawnError;
      let bytes=0,stderrBytes=0;const chunks=[];
      const settle=(error,value)=>{if(finished)return;finished=true;clearTimeout(grace);clearTimeout(finalTimer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
      function abort(){
        failureReason??=signal.reason??fail('ocr_cancelled','OCR was cancelled');
        try{child?.stdin.write('{"cancel":true}\n');}catch{/* The independent cleanup deadline still applies. */}
        if(!grace)grace=setTimeout(()=>{
          forced=true;try{child?.kill('SIGKILL');}catch{}
          finalTimer=setTimeout(()=>{
            if(!closed){quarantined=true;orphans.add(child);settle(fail('ocr_cleanup_unknown','OCR cleanup was not confirmed; restart only after operator review'));}
          },250);
        },cleanupGraceMs);
      }
      function stop(code,message){failureReason??=fail(code,message);abort();}
      const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','LANG'])if(process.env[key])env[key]=process.env[key];
      env.PATH=path.win32.join(process.env.SystemRoot??'C:\\Windows','System32');
      try{child=spawnImpl(pythonPath,[launcher],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});}
      catch{settle(fail('ocr_unavailable','The trusted OCR wrapper could not be started'));return;}
      child.stdout.on('data',chunk=>{const value=Buffer.from(chunk);bytes+=value.length;if(bytes<=OUTPUT)chunks.push(value);else stop('ocr_output_limit','OCR output exceeded its bound');});
      child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderrBytes>8192)stop('ocr_output_limit','OCR diagnostics exceeded their bound');});
      child.stdin.on('error',()=>{if(!closed&&!failureReason)stop('ocr_process_failed','OCR input stream failed');});
      child.once('error',error=>{spawnError=error;});
      child.once('close',()=>{
        closed=true;orphans.delete(child);clearTimeout(grace);clearTimeout(finalTimer);
        if(finished)return;
        if(spawnError&&!child.pid&&['ENOENT','EACCES'].includes(spawnError.code)){settle(fail('ocr_unavailable','The trusted OCR wrapper could not be started'));return;}
        let envelope,resource;
        try{
          if(forced||bytes>OUTPUT||stderrBytes>8192)throw fail('ocr_cleanup_unknown','OCR wrapper closed without an acknowledged cleanup receipt');
          envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
          if(!keys(envelope,['ok','code','identity','native','resource'])||typeof envelope.ok!=='boolean')throw fail('ocr_receipt_invalid','OCR wrapper returned invalid JSON metadata');
          resource=cleanupProof(envelope.resource);
          if(!resource.cleanupConfirmed)throw fail('ocr_cleanup_unknown','OCR native process cleanup was not confirmed',resource);
          if(envelope.identity!==undefined&&(!keys(envelope.identity,Object.keys(expected))||Object.keys(envelope.identity).length!==3||Object.keys(expected).some(key=>envelope.identity[key]!==expected[key])))throw fail('ocr_receipt_invalid','OCR trusted helper identity changed');
          if(!envelope.identity&&!(resource.notCreated&&!envelope.ok))throw fail('ocr_receipt_invalid','OCR helper identity is missing');
        }catch(error){quarantined=true;settle(error.code?error:fail('ocr_receipt_invalid','OCR wrapper returned an invalid bounded receipt'));return;}
        if(failureReason||signal.aborted){settle(fail(failureReason?.code?.startsWith('ocr_')?failureReason.code:'ocr_cancelled','OCR did not complete before cancellation',resource));return;}
        if(!envelope.ok){settle(fail(ERRORS.has(envelope.code)?envelope.code:'ocr_native_failed','The local OCR helper did not recognize this input',resource));return;}
        if(!resource.jobVerifiedBeforeResume||resource.notCreated||!resource.childPid||resource.exitCode!==0){quarantined=true;settle(fail('ocr_receipt_invalid','OCR execution did not prove its verified Job',resource));return;}
        settle(null,{native:envelope.native,resource});
      });
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      try{child.stdin.write(JSON.stringify(request)+'\n');}catch{stop('ocr_process_failed','OCR request could not be sent');}
    });
  }
  function invoke(request,signal) {
    const controller=new AbortController();let acquired=false;
    const cancelled=()=>controller.abort(fail('ocr_cancelled','OCR was cancelled'));
    if(signal?.aborted)cancelled();else signal?.addEventListener('abort',cancelled,{once:true});
    const timer=setTimeout(()=>controller.abort(fail('ocr_timeout','OCR exceeded its 15 second deadline')),deadlineMs);
    controllers.add(controller);
    const promise=(async()=>{
      if(closing)throw fail('ocr_closed','OCR is shutting down');
      if(platform!=='win32')throw fail('ocr_unavailable','Windows OCR is unavailable on this platform');
      if(quarantined)throw fail('ocr_quarantined','OCR is disabled after unconfirmed native cleanup');
      await acquire(controller.signal);acquired=true;
      if(closing||quarantined)throw fail('ocr_quarantined','OCR cannot start after shutdown or unconfirmed cleanup');
      const expected=await identity();controller.signal.throwIfAborted();
      return {...await worker(request,controller.signal,expected),identity:expected};
    })().finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);controllers.delete(controller);if(acquired)release();});
    pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
  }
  async function health({signal}={}) {
    try{
      const response=await invoke({action:'health'},signal),native=nativeHealth(response.native);
      return freeze({available:native.available,engine:'windows-media-ocr',languages:[...native.languages],maxImageDimension:native.maxImageDimension,
        identity:{...response.identity,osBuild:native.osBuild},accuracyVerified:false,requiresReview:true,confidenceAvailable:false,resource:response.resource});
    }catch(error){
      if(signal?.aborted)throw error;
      return freeze({available:false,engine:'windows-media-ocr',languages:[],maxImageDimension:null,accuracyVerified:false,requiresReview:true,confidenceAvailable:false,reason:error.code??'ocr_unavailable',quarantined});
    }
  }
  async function recognize(data,{mimeType,language='en-US',signal}={}) {
    if(!Buffer.isBuffer(data)||!data.length||data.length>4*1024*1024||!['image/png','image/jpeg'].includes(mimeType))throw fail('ocr_invalid_image','OCR requires PNG or JPEG bytes up to 4 MiB');
    if(language!=='en-US')throw fail('ocr_invalid_language','The local OCR adapter currently requires en-US');
    const bytes=Buffer.from(data);let dimensions;
    try{dimensions=validateImage(bytes,mimeType);}catch{throw fail('ocr_invalid_image','OCR image structure is invalid');}
    if(dimensions.width>4096||dimensions.height>4096||dimensions.width*dimensions.height>4000000)throw fail('ocr_image_limit','OCR input exceeds 4096 pixels per edge or 4 megapixels');
    const imageSha256=sha(bytes),response=await invoke({action:'recognize',imageBase64:bytes.toString('base64'),mimeType,language},signal);
    const native=nativeHealth(response.native);
    if(native.ok!==true||!native.available||native.language!==language||native.width!==dimensions.width||native.height!==dimensions.height
      ||native.imageSha256!==imageSha256||!digest(native.imageSha256)||!text(native.text)||Buffer.byteLength(native.text)>65536
      ||native.textBytes!==Buffer.byteLength(native.text)||!integer(native.wordCount,4000)||!Array.isArray(native.lines)||native.lines.length>1000
      ||native.lines.some(line=>!keys(line,['text'])||Object.keys(line).length!==1||!text(line.text))
      ||native.lines.map(line=>line.text).join('\n')!==native.text||native.orientation!=='raw-pixels-exif-ignored')throw fail('ocr_receipt_invalid','OCR result does not match its exact input and bounded text contract',response.resource);
    return freeze({text:native.text,lines:native.lines.map(line=>({text:line.text})),wordCount:native.wordCount,
      engine:{name:'windows-media-ocr',language,...response.identity,osBuild:native.osBuild,maxImageDimension:native.maxImageDimension,
        accuracyVerified:false,requiresReview:true,confidenceAvailable:false,orientation:native.orientation},
      dimensions:{width:dimensions.width,height:dimensions.height},imageSha256,resource:response.resource});
  }
  async function close(){closing=true;for(const controller of controllers)controller.abort(fail('ocr_cancelled','OCR is shutting down'));await Promise.allSettled([...pending]);return {callbacksSettled:pending.size===0&&orphans.size===0,cleanupConfirmed:!quarantined&&orphans.size===0,quarantined};}
  return Object.freeze({health,recognize,close});
}
