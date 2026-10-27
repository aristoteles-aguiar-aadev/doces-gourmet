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
    console.error('Falha ao inicializar a loja:',error.name,error.code||'');
    response.statusCode=503;response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({error:'A loja está temporariamente indisponível. Tente novamente.'}));
  }
}
