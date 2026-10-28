import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from '../server/artifacts.js';

test('immutable uploaded text is integrity-checked and marked untrusted', async () => {
  const root=mkdtempSync(join(tmpdir(),'fraymus-assets-'));
  try {
    const store=createArtifactStore(root), item=store.put({name:'source.txt',mimeType:'text/plain',dataBase64:Buffer.from('Read me: φ').toString('base64')});
    assert.equal(store.inspect(item.id).data.toString(),'Read me: φ');
    assert.match((await store.resolve([item.id])).text,/untrusted/);
    assert.equal((await store.tools()[0].execute({args:{assetId:item.id}})).text,'Read me: φ');
    assert.throws(()=>store.inspect('../escape'),/Invalid/);
    assert.throws(()=>store.put({name:'bad.png',mimeType:'image/png',dataBase64:Buffer.from('fake image').toString('base64')}),/signature/);
    assert.throws(()=>store.put({name:'bad.txt',mimeType:'text/plain',dataBase64:'/w=='}));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
