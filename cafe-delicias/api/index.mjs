import {createApp} from '../server.mjs';

let application;
export default async function handler(request,response){
  try{
    application??=createApp({serverless:true});
    const app=await application;
    const incoming=new URL(request.url,'http://localhost');
    const route=incoming.searchParams.get('__route');
    if(route){incoming.searchParams.delete('__route');request.url=route+(incoming.search?incoming.search:'');}
    await new Promise(resolve=>{response.once('finish',resolve);response.once('close',resolve);app.emit('request',request,response);});
  }catch(error){
    application=undefined;
    let detail=String(error.message||'');
    for(const [name,value] of Object.entries(process.env))if(/TOKEN|PASSWORD|SECRET/i.test(name)&&value)detail=detail.replaceAll(value,'[redacted]');
    console.error('Falha ao inicializar a loja:',error.name,error.code||'',detail.slice(0,500));
    response.statusCode=503;response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({error:'A loja está temporariamente indisponível. Tente novamente.'}));
  }
}
