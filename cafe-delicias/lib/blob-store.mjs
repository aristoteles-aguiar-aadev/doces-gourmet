import {initialState} from './seed.mjs';

// Private Blob is the shared source of truth. Never use /tmp for durable data.
export class BlobStore {
  constructor({sdk,key='system/loja.json'}={}){this.sdk=sdk;this.key=key;}
  async client(){return this.sdk??=await import('@vercel/blob');}
  async snapshot(){
    const sdk=await this.client();const result=await sdk.get(this.key,{access:'private',useCache:false});
    if(!result)return null;
    if(!result.stream||!result.blob.etag)throw new Error('Armazenamento retornou uma versão inválida.');
    return {state:JSON.parse(await new Response(result.stream).text()),etag:result.blob.etag};
  }
  async init(){
    if(await this.snapshot())return;
    const sdk=await this.client();
    try{await sdk.put(this.key,JSON.stringify(initialState()),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});}
    catch(e){if(!(await this.snapshot()))throw e;}
  }
  async read(){const snapshot=await this.snapshot();if(!snapshot)throw new Error('Banco da loja indisponível.');return snapshot.state;}
  async update(fn){
    for(let attempt=0;attempt<10;attempt++){
      const snapshot=await this.snapshot();if(!snapshot)throw new Error('Banco da loja indisponível.');
      const result=await fn(snapshot.state);const sdk=await this.client();
      try{await sdk.put(this.key,JSON.stringify(snapshot.state),{access:'private',addRandomSuffix:false,allowOverwrite:true,ifMatch:snapshot.etag,contentType:'application/json'});return result;}
      catch(e){if(!sdk.BlobPreconditionFailedError||!(e instanceof sdk.BlobPreconditionFailedError))throw e;}
    }
    const error=new Error('A loja recebeu alterações simultâneas. Tente novamente.');error.status=409;throw error;
  }
  async saveAsset(path,bytes,contentType){const sdk=await this.client();await sdk.put(path,bytes,{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType});}
  async readAsset(path){const sdk=await this.client();const result=await sdk.get(path,{access:'private',useCache:false});if(!result)return null;return Buffer.from(await new Response(result.stream).arrayBuffer());}
}
