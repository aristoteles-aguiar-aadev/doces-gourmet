import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';
import {initialState} from './seed.mjs';
export class FileStore {
  constructor(directory) {this.directory=directory;this.file=join(directory,'loja.json');this.queue=Promise.resolve();}
  async init(){
    await mkdir(this.directory,{recursive:true});
    try{JSON.parse(await readFile(this.file,'utf8'));}
    catch(e){if(e.code!=='ENOENT') throw new Error('Não foi possível ler o banco. Restaure um backup antes de iniciar.'); await this.persist(initialState());}
  }
  async persist(state){
    const temporary=this.file+'.tmp';
    const handle=await open(temporary,'w',0o600);
    try{await handle.writeFile(JSON.stringify(state,null,2));await handle.sync();}finally{await handle.close();}
    await rename(temporary,this.file);
  }
  async read(){await this.queue;return JSON.parse(await readFile(this.file,'utf8'));}
  update(fn){
    const job=this.queue.then(async()=>{
      const state=JSON.parse(await readFile(this.file,'utf8'));
      const result=await fn(state);await this.persist(state);return result;
    });
    this.queue=job.catch(()=>{});return job;
  }
}
