import {test} from 'node:test';
import assert from 'node:assert/strict';

// The test double models the external ETag contract, not application logic.
function blobService(){
  const objects=new Map();let revision=0;
  return {
    async get(path,options){assert.equal(options.access,'private');assert.equal(options.useCache,false);const blob=objects.get(path);if(!blob)return null;return {statusCode:200,stream:new Response(blob.body).body,blob:{etag:blob.etag,contentType:blob.type}};},
    async put(path,body,options){assert.equal(options.access,'private');const previous=objects.get(path);if((previous&&!options.allowOverwrite)||(options.ifMatch&&previous?.etag!==options.ifMatch)){const e=new Error('Conflict');e.name=options.ifMatch?'BlobPreconditionFailedError':'BlobAlreadyExistsError';throw e;}const etag=String(++revision);objects.set(path,{body:typeof body==='string'?body:Buffer.from(body),etag,type:options.contentType});return {etag};}
  };
}
test('Blob privado preserva gravações concorrentes de instâncias diferentes',async()=>{
  const {BlobStore}=await import('../lib/blob-store.mjs');const sdk=blobService();const a=new BlobStore({sdk}),b=new BlobStore({sdk});
  await Promise.all([a.init(),b.init()]);
  await Promise.all([a.update(s=>{s.settings.counter=(s.settings.counter||0)+1;}),b.update(s=>{s.settings.counter=(s.settings.counter||0)+1;})]);
  const reopened=new BlobStore({sdk});assert.equal((await reopened.read()).settings.counter,2);
});
test('Blob privado guarda uploads sem colocar dados pessoais em URL pública',async()=>{
  const {BlobStore}=await import('../lib/blob-store.mjs');const store=new BlobStore({sdk:blobService()});await store.init();
  await store.saveAsset('uploads/test.jpg',Buffer.from('photo'),'image/jpeg');
  assert.equal((await store.readAsset('uploads/test.jpg')).toString(),'photo');
  assert.equal(await store.readAsset('uploads/missing.jpg'),null);
});
