import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, fetchPublicText, spectrum, transportBenchmark } from '../server/extension-tools.js';
test('public retrieval denies loopback, private, mapped and reserved addresses',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  for (const ip of ['2001::1','2001:0000:ffff::1','2001:20::1','2001:0db8::1','3fff::1']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('2001:4860:4860::8888'),true);
  await assert.rejects(fetchPublicText('http://127.0.0.1/'),/blocked/);
  await assert.rejects(fetchPublicText('https://example.com/',{lookupImpl:async()=>[{address:'127.0.0.1',family:4}]}),/blocked/);
  await assert.rejects(fetchPublicText('https://user:secret@example.com/'),/ordinary/);
});
test('spectral analysis recovers the known supplied frequency',()=>{
  const samples=Array.from({length:128},(_,i)=>Math.sin(2*Math.PI*16*i/128));
  const result=spectrum(samples,128);assert.equal(result.peaks[0].frequencyHz,16);assert.ok(Math.abs(result.peaks[0].amplitude-1)<1e-10);
  assert.throws(()=>spectrum([NaN,1,2,3],100),/finite/);
});
test('transport benchmark verifies each distribution without claiming universal compression',()=>{
  const report=transportBenchmark();assert.equal(report.cases.length,4);
  assert.ok(report.cases.every(x=>x.byteExact&&x.parityRecoveryExact));
  assert.ok(report.cases.find(x=>x.name==='seeded-high-entropy').pngBytes>16384);
});
