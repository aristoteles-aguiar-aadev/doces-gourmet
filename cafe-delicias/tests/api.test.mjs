import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {request as httpRequest} from 'node:http';

test('API protege painel, persiste produto e não inventa pagamento sem credencial',async()=>{
  const {createApp}=await import('../server.mjs');
  const directory=await mkdtemp(join(tmpdir(),'delicias-api-'));
  const app=await createApp({dataDir:directory,adminPassword:'senha-forte-de-teste',quiet:true});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const call=(path,body,cookie)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Shop-Request':'1',Origin:base,...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try{
    assert.equal((await call('/api/admin/products')).status,401);
    assert.equal((await call('/api/login',{password:'errada'})).status,401);
    const login=await call('/api/login',{password:'senha-forte-de-teste'});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const product={name:'Teste de doce',category:'Brigadeiros',description:'',price:550,stock:3,active:true,image:'/marca.jpeg'};
    const saved=await call('/api/admin/products',product,cookie);assert.equal(saved.status,201);
    const {id}=await saved.json();
    const catalog=await(await call('/api/catalog')).json();assert.equal(catalog.products.find(p=>p.id===id).price,550);
    const csrf=await fetch(base+'/api/admin/products',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'https://outro.example'},body:JSON.stringify(product)});assert.equal(csrf.status,403);
    const checkout=await call('/api/checkout',{items:[{id,quantity:1}],fulfillment:'pickup',name:'Maria Silva',email:'maria@example.com',phone:'85999999999',method:'pix',key:'a'.repeat(32)});
    assert.equal(checkout.status,503);
    const orders=await(await call('/api/admin/orders',null,cookie)).json();assert.equal(orders.orders.length,0);
    const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/Café/);
    assert.equal((await fetch(base+'/data/loja.json')).status,404);
  }finally{await new Promise(resolve=>app.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('checkout reserva estoque uma vez, filtra pagamento e exige confirmação assinada',async()=>{
  const {createApp}=await import('../server.mjs');const {FileStore}=await import('../lib/store.mjs');
  const directory=await mkdtemp(join(tmpdir(),'delicias-pay-'));const store=new FileStore(directory);await store.init();
  await store.update(s=>{s.settings.catalogExample=false;s.settings.pickupAddress='Rua Exemplo, 123';s.products=[{id:'doce',name:'Doce de teste',price:450,stock:2,active:true}];});
  let preferenceBody,orderId,providerCalls=0,providerStatus='rejected';
  const app=await createApp({dataDir:directory,adminPassword:'senha-forte-de-teste',quiet:true,accessToken:'token-test',webhookSecret:'secret-test',baseUrl:'https://loja.example',paymentFetch:async(url,init)=>{
    if(url.endsWith('/checkout/preferences')){providerCalls++;preferenceBody=JSON.parse(init.body);orderId=preferenceBody.external_reference;return Response.json({id:'pref-test',init_point:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-test'});}
    if(/\/v1\/payments\/\d+$/.test(url))return Response.json({id:Number(url.split('/').pop()),external_reference:orderId,currency_id:'BRL',transaction_amount:4.5,status:providerStatus});
    throw new Error('Unexpected provider request');
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  const payload={items:[{id:'doce',quantity:1,price:1}],fulfillment:'pickup',method:'pix',name:'Maria Silva',email:'maria@example.com',phone:'85999999999',key:'b'.repeat(32)};
  const checkout=()=>fetch(base+'/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','X-Shop-Request':'1',Origin:'https://loja.example'},body:JSON.stringify(payload)});
  try{
    const [first,second]=await Promise.all([checkout(),checkout()]);assert.equal(first.status,200);const a=await first.json();
    assert.equal(second.status,200);assert.equal((await second.json()).id,a.id);
    assert.equal(providerCalls,1);assert.equal(preferenceBody.items[0].unit_price,4.5);assert.equal(preferenceBody.payment_methods.excluded_payment_types.some(x=>x.id==='bank_transfer'),false);
    assert.equal((await store.read()).products[0].stock,1);assert.equal((await store.read()).orders[0].status,'pending');
    assert.equal((await fetch(base+`/api/orders/${a.id}?key=wrong`)).status,404);
    const forged=await fetch(base+'/api/payments/webhook?data.id=123',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'payment',data:{id:'123'}})});assert.equal(forged.status,401);assert.equal((await store.read()).orders[0].status,'pending');
    const ts=String(Date.now());
    const notify=(id)=>{const signature=createHmac('sha256','secret-test').update(`id:${id};request-id:req-test;ts:${ts};`).digest('hex');return fetch(base+`/api/payments/webhook?data.id=${id}`,{method:'POST',headers:{'Content-Type':'application/json','x-request-id':'req-test','x-signature':`ts=${ts},v1=${signature}`},body:JSON.stringify({type:'payment',data:{id}})});};
    assert.equal((await notify('123')).status,200);assert.equal((await store.read()).orders[0].status,'rejected');
    providerStatus='approved';assert.equal((await notify('124')).status,200);assert.equal((await notify('124')).status,200);
    const receipt=await(await fetch(base+`/api/orders/${a.id}?key=${a.receiptToken}`)).json();assert.equal(receipt.order.status,'paid');assert.equal((await store.read()).products[0].stock,1);
    providerStatus='pending';await notify('123');assert.equal((await store.read()).orders[0].status,'paid');
    payload.key='c'.repeat(32);payload.items[0].quantity=2;assert.equal((await checkout()).status,409);
  }finally{await new Promise(resolve=>app.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('sessão administrativa sobrevive a outra instância e logout revoga em ambas',async()=>{
  const {createApp}=await import('../server.mjs');const directory=await mkdtemp(join(tmpdir(),'delicias-session-'));
  const a=await createApp({dataDir:directory,adminPassword:'senha-forte-de-teste',quiet:true});
  await new Promise(resolve=>a.listen(0,'127.0.0.1',resolve));
  let b;
  try{
    const baseA=`http://127.0.0.1:${a.address().port}`;
    const login=await fetch(baseA+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Shop-Request':'1',Origin:baseA},body:JSON.stringify({password:'senha-forte-de-teste'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    b=await createApp({dataDir:directory,quiet:true});await new Promise(resolve=>b.listen(0,'127.0.0.1',resolve));const baseB=`http://127.0.0.1:${b.address().port}`;
    assert.equal((await fetch(baseB+'/api/admin/products',{headers:{Cookie:cookie}})).status,200);
    const backup=await(await fetch(baseB+'/api/admin/backup',{headers:{Cookie:cookie}})).json();assert.equal(backup.sessions,undefined);assert.equal(backup.loginAttempts,undefined);assert.equal(backup.admin,undefined);
    await fetch(baseB+'/api/logout',{method:'POST',headers:{Cookie:cookie,'X-Shop-Request':'1',Origin:baseB}});
    assert.equal((await fetch(baseA+'/api/admin/products',{headers:{Cookie:cookie}})).status,401);
  }finally{await new Promise(resolve=>a.close(resolve));if(b)await new Promise(resolve=>b.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('login Vercel aceita aliases do próprio site e continua bloqueando outras origens',async()=>{
  const {createApp}=await import('../server.mjs');const {FileStore}=await import('../lib/store.mjs');
  const directory=await mkdtemp(join(tmpdir(),'delicias-alias-'));
  const app=await createApp({serverless:true,store:new FileStore(directory),baseUrl:'https://cafesdelicias.vercel.app',adminPassword:'senha-forte-de-teste',quiet:true});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  const login=(host,origin,extra={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api/login',{method:'POST',headers:{Host:host,Origin:origin,'Content-Type':'application/json','X-Shop-Request':'1',...extra}},res=>{
      res.resume();res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0]}));
    });req.on('error',reject);req.end(JSON.stringify({password:'senha-forte-de-teste'}));
  });
  try{
    for(const host of ['cafesdelicias.vercel.app','doces-gourmet-aristoteles-aguiars-projects.vercel.app']){
      const response=await login(host,`https://${host}`);assert.equal(response.status,200,host);assert.match(response.cookie,/; Secure/);
    }
    assert.equal((await login('cafesdelicias.vercel.app','https://outro.example')).status,403);
    assert.equal((await login('cafesdelicias.vercel.app','https://outro.example',{'X-Forwarded-Host':'outro.example'})).status,403);
    assert.equal((await login('cafesdelicias.vercel.app','https://cafesdelicias.vercel.app',{'X-Shop-Request':''})).status,403);
    assert.equal((await login('cafesdelicias.vercel.app','null')).status,403);
  }finally{await new Promise(resolve=>app.close(resolve));await rm(directory,{recursive:true,force:true});}
});
