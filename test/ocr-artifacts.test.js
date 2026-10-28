import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createArtifactStore} from '../server/artifacts.js';
import {encodeRgbaPng} from '../server/transport/rgba.js';
import {pdfFixture} from './document-fixtures.js';
const hash=data=>createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const parent=await fs.realpath(fileURLToPath(new URL('../../work/',import.meta.url)));
  const directory=await fs.mkdtemp(path.join(parent,'ocr-artifacts-')),original=await fs.realpath(directory),store=createArtifactStore(directory);
  t.after(async()=>{
    assert.equal(await fs.realpath(directory),original);assert.equal(path.dirname(original),parent);assert.ok(path.basename(original).startsWith('ocr-artifacts-'));
    for(const name of await fs.readdir(directory)){assert.match(name,/^[a-f0-9-]{36}\.(?:bin|json|document\.json)$/);await fs.unlink(path.join(directory,name));}
    await fs.rmdir(directory);
  });
  const image=store.put({name:'source.png',mimeType:'image/png',dataBase64:encodeRgbaPng(Buffer.from('owned OCR fixture')).png.toString('base64')});
  const pdfId=randomUUID(),data=pdfFixture(['','']),document={kind:'pdf',pages:2,imageOnlyPages:[1,2],text:'',spans:[],sourceSha256:hash(data)};
  const serialized=Buffer.from(JSON.stringify(document)),metadata={id:pdfId,assetId:pdfId,name:'image-only.pdf',mimeType:'application/pdf',size:data.length,sha256:hash(data),document:{kind:'pdf',pages:2,textChars:0},documentSha256:hash(serialized)};
  await fs.writeFile(path.join(directory,pdfId+'.bin'),data);await fs.writeFile(path.join(directory,pdfId+'.document.json'),serialized);await fs.writeFile(path.join(directory,pdfId+'.json'),JSON.stringify(metadata));
  return {store,directory,image,pdfId,document,metadata,run:{attachments:[image.id,pdfId]}};
}

test('OCR source authorization precedes ID/disk access and admits only explicitly attached sources',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.store.ocrInput('../escape',{},f.run),/not attached/);
  assert.throws(()=>f.store.ocrInput(f.image.id,{}),/not attached/);
  assert.throws(()=>f.store.ocrInput(f.image.id,{}, {attachments:[]}),/not attached/);
  const text=f.store.put({name:'plain.txt',mimeType:'text/plain',dataBase64:Buffer.from('not OCR').toString('base64')});
  assert.throws(()=>f.store.ocrInput(text.id,{}, {attachments:[text.id]}),/PNG, JPEG or explicit PDF/);
});

test('attached image source is copied with deeply frozen metadata and page selectors are rejected',async t=>{
  const f=await fixture(t),first=f.store.ocrInput(f.image.id,{},f.run),before=Buffer.from(first.data);
  assert.equal(first.metadata.sha256,hash(first.data));assert.equal(first.page,undefined);
  assert.ok(Object.isFrozen(first.metadata));assert.ok(Object.isFrozen(first.metadata.image));
  assert.throws(()=>{first.metadata.image.width=42;},TypeError);first.data.fill(0);
  assert.deepEqual(f.store.ocrInput(f.image.id,{},f.run).data,before);
  assert.throws(()=>f.store.ocrInput(f.image.id,{page:1},f.run),/only valid for PDF/);
  assert.throws(()=>f.store.ocrInput(f.image.id,{path:'host'},f.run),/only an explicit PDF page/);
});

test('explicit PDF page accepts image-only pages without native extracted text and enforces indexed bounds',async t=>{
  const f=await fixture(t),input=f.store.ocrInput(f.pdfId,{page:2},f.run);
  assert.equal(input.page,2);assert.equal(input.metadata.sha256,hash(input.data));assert.equal(input.metadata.document.pages,2);
  for(const page of [undefined,0,3,1.5,'1'])assert.throws(()=>f.store.ocrInput(f.pdfId,{page},f.run),/explicit PDF page/);
});

test('OCR PDF bytes and document index are hash-checked before disclosure',async t=>{
  const f=await fixture(t),sidecar=path.join(f.directory,f.pdfId+'.document.json');
  await fs.appendFile(sidecar,' ');assert.throws(()=>f.store.ocrInput(f.pdfId,{page:1},f.run),/index integrity/);
  const wrong=Buffer.from(JSON.stringify({...f.document,sourceSha256:'0'.repeat(64)}));await fs.writeFile(sidecar,wrong);
  await fs.writeFile(path.join(f.directory,f.pdfId+'.json'),JSON.stringify({...f.metadata,documentSha256:hash(wrong)}));
  assert.throws(()=>f.store.ocrInput(f.pdfId,{page:1},f.run),/source integrity/);
  await fs.appendFile(path.join(f.directory,f.image.id+'.bin'),'x');assert.throws(()=>f.store.ocrInput(f.image.id,{},f.run),/Asset integrity/);
});

test('local OCR resolution sends image references only while default and local helper modes keep their contracts',async t=>{
  const f=await fixture(t),ocr=await f.store.resolve([f.image.id],{imageMode:'local-ocr'});
  assert.deepEqual(ocr.images,[]);assert.match(ocr.text,/artifact\.ocrText/);assert.match(ocr.text,new RegExp(f.image.sha256));assert.match(ocr.text,/no authority/);
  const direct=await f.store.resolve([f.image.id]);assert.equal(direct.images.length,1);assert.equal(direct.text,'');
  const helper=await f.store.resolve([f.image.id],{imageMode:'local-tool'});assert.deepEqual(helper.images,[]);assert.match(helper.text,/artifact\.analyzeImage/);assert.doesNotMatch(helper.text,/artifact\.ocrText/);
});
