import http from 'node:http';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHmac,createHash} from 'node:crypto';
import {FileStore} from './lib/store.mjs';
import {BlobStore} from './lib/blob-store.mjs';
import {ShopError,text,validateProduct,quote,customerInput,categories} from './lib/shop.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const secureEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const hash=(p,s)=>scryptSync(p,s,64).toString('hex');
const publicOrder=o=>({id:o.id,createdAt:o.createdAt,status:o.status,fulfillment:o.fulfillment,items:o.items,subtotal:o.subtotal,deliveryFee:o.deliveryFee,total:o.total,method:o.method,checkoutUrl:o.checkoutUrl||null});

export async function createApp(options={}) {
  const serverless=options.serverless??Boolean(process.env.VERCEL);
  const origin=process.env.PUBLIC_BASE_URL||(process.env.VERCEL_PROJECT_PRODUCTION_URL?`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`:undefined);
  const config={dataDir:process.env.DATA_DIR||join(root,'data'),adminPassword:process.env.ADMIN_PASSWORD,accessToken:process.env.MP_ACCESS_TOKEN,webhookSecret:process.env.MP_WEBHOOK_SECRET,baseUrl:origin,...options};
  if(config.baseUrl)config.baseUrl=new URL(config.baseUrl).origin;
  const store=options.store||(serverless?new BlobStore():new FileStore(config.dataDir));await store.init();
  // One server process owns this file store. A second process must never write it.
  const requestLimits=new Map(),checkoutFlights=new Map();
  const current=await store.read();
  if(!current.admin||(config.adminPassword&&!secureEqual(hash(config.adminPassword,current.admin.salt),current.admin.hash))){
    const password=config.adminPassword||randomBytes(18).toString('base64url');
    if(password.length<12)throw new Error('ADMIN_PASSWORD precisa ter pelo menos 12 caracteres.');
    const salt=randomBytes(24).toString('hex');
    const created=await store.update(s=>{
      if(s.admin&&!config.adminPassword)return false;
      if(s.admin&&secureEqual(hash(password,s.admin.salt),s.admin.hash))return false;
      s.admin={salt,hash:hash(password,salt)};s.sessions={};return true;
    });
    if(created&&!config.adminPassword){
      const content=`Acesso ao painel /admin\nSenha: ${password}\nGuarde este arquivo em local seguro.\n`;
      if(serverless)await store.saveAsset('system/acesso-admin.txt',content,'text/plain');
      else await writeFile(join(config.dataDir,'acesso-admin.txt'),content,{mode:0o600});
    }
  }
  if(!options.quiet)console.log(serverless?'Painel /admin: acesso inicial no Blob privado system/acesso-admin.txt.':'Painel /admin: use a senha configurada ou consulte data/acesso-admin.txt.');
  const ready=()=>Boolean(config.accessToken&&config.webhookSecret&&/^https:\/\//.test(config.baseUrl||''));
  async function mp(path,init={}) {
    const response=await (options.paymentFetch||fetch)(`https://api.mercadopago.com${path}`,{...init,headers:{Authorization:`Bearer ${config.accessToken}`,'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new ShopError('Não foi possível acessar o pagamento. Tente novamente em instantes.',502);
    return response.json();
  }
  async function reconcile(paymentId) {
    const p=await mp(`/v1/payments/${encodeURIComponent(paymentId)}`);
    await store.update(s=>{
      const o=s.orders.find(o=>o.id===p.external_reference);if(!o)return;
      if(p.currency_id!=='BRL'||Math.round(Number(p.transaction_amount)*100)!==o.total) throw new ShopError('Valor do pagamento não corresponde ao pedido.',409);
      if(['paid','refunded','charged_back'].includes(o.status)&&o.paymentId&&String(o.paymentId)!==String(p.id))return;
      // Never downgrade an approved payment because of a delayed pending notification.
      const mapping={approved:'paid',refunded:'refunded',charged_back:'charged_back',cancelled:'cancelled',rejected:'rejected',pending:'pending',in_process:'pending',authorized:'pending',in_mediation:'in_mediation'};
      const next=mapping[p.status];if(!next)return;
      if(['paid','refunded','charged_back'].includes(o.status)&&['pending','cancelled','rejected'].includes(next))return;
      o.paymentId=String(p.id);o.status=next;o.updatedAt=new Date().toISOString();
      // Pending/rejected attempts may be retried at the provider. Stock is held until
      // the administrator explicitly releases an expired preference after checking it.
    });
  }
  async function body(req,max=3000000) {
    if(req.body!==undefined){const data=typeof req.body==='string'?req.body:JSON.stringify(req.body);if(Buffer.byteLength(data)>max)throw new ShopError('Solicitação muito grande.',413);try{return JSON.parse(data);}catch{throw new ShopError('Dados inválidos.');}}
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>max)throw new ShopError('Arquivo ou solicitação muito grande.',413);chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new ShopError('Dados inválidos.');}
  }
  const app=http.createServer(async(req,res)=>{
    const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const client=serverless?String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||'unknown').split(',')[0].trim():req.socket.remoteAddress,now=Date.now();
      if(requestLimits.size>10000)requestLimits.clear();
      const rate=requestLimits.get(client)||{time:now,count:0};if(now-rate.time>60000){rate.time=now;rate.count=0;}requestLimits.set(client,rate);
      if(++rate.count>300)throw new ShopError('Muitas solicitações. Aguarde um minuto.',429);
      const cookies=String(req.headers.cookie||'').split(';').map(c=>c.trim().split('='));
      const token=cookies.find(([k])=>k==='delicias_session')?.[1];
      const tokenHash=token&&createHash('sha256').update(token).digest('hex');
      const session=tokenHash&&(await store.read()).sessions?.[tokenHash];const admin=Boolean(session&&session.expires>now);
      if(path.startsWith('/api/admin/')&&!admin)throw new ShopError('Entre no painel para continuar.',401);
      if(path.startsWith('/api/')&&!['GET','HEAD'].includes(req.method)&&path!=='/api/payments/webhook') {
        // Vercel routes each registered alias to this project. Compare against
        // the actual request host, rather than the canonical payment-return URL.
        // Forwarded host headers are deliberately not trusted here.
        const host=req.headers.host;
        if(serverless&&(typeof host!=='string'||! /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)))throw new ShopError('Solicitação não autorizada.',403);
        const expected=serverless?new URL(`https://${host}`).origin:config.baseUrl?new URL(config.baseUrl).origin:`http://${host}`;
        if(req.headers['x-shop-request']!=='1'||(req.headers.origin&&req.headers.origin!==expected))throw new ShopError('Solicitação não autorizada.',403);
      }
      if(path==='/api/session'&&req.method==='GET')return json({authenticated:admin,paymentsReady:ready(),hosted:serverless});
      if(path==='/api/login'&&req.method==='POST'){
        const addressHash=createHash('sha256').update(client||'unknown').digest('hex');
        const allowed=await store.update(s=>{s.loginAttempts??={};for(const [key,a] of Object.entries(s.loginAttempts))if(now-a.time>900000)delete s.loginAttempts[key];const a=s.loginAttempts[addressHash]??={time:now,count:0};return ++a.count<=8;});
        if(!allowed)throw new ShopError('Muitas tentativas. Aguarde 15 minutos.',429);
        const b=await body(req,2000);const s=await store.read();
        if(typeof b.password!=='string'||b.password.length>200||!secureEqual(hash(b.password,s.admin.salt),s.admin.hash))throw new ShopError('Senha incorreta.',401);
        const value=randomBytes(32).toString('hex'),sessionKey=createHash('sha256').update(value).digest('hex');
        await store.update(s=>{delete s.loginAttempts?.[addressHash];s.sessions??={};for(const [key,v] of Object.entries(s.sessions))if(v.expires<now)delete s.sessions[key];s.sessions[sessionKey]={expires:now+12*3600000};});
        res.setHeader('Set-Cookie',`delicias_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${serverless||config.baseUrl?.startsWith('https:')?'; Secure':''}`);
        return json({ok:true});
      }
      if(path==='/api/logout'&&req.method==='POST'){if(tokenHash)await store.update(s=>{delete s.sessions?.[tokenHash];});res.setHeader('Set-Cookie','delicias_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json({ok:true});}
      if(path==='/api/catalog'&&req.method==='GET'){
        const s=await store.read();return json({products:s.products.filter(p=>p.active),settings:s.settings,categories,paymentsReady:ready()});
      }
      if(path==='/api/admin/products'){
        if(req.method==='GET')return json({products:(await store.read()).products,categories});
        if(req.method==='POST'){
          const p={...validateProduct(await body(req)),id:randomUUID(),updatedAt:new Date().toISOString()};
          await store.update(s=>{s.products.unshift(p);});return json(p,201);
        }
      }
      const productMatch=path.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
      if(productMatch&&['PUT','DELETE'].includes(req.method)){
        const p=req.method==='PUT'?validateProduct(await body(req)):null;
        await store.update(s=>{const index=s.products.findIndex(p=>p.id===productMatch[1]);if(index<0)throw new ShopError('Produto não encontrado.',404);if(p)s.products[index]={...p,id:productMatch[1],updatedAt:new Date().toISOString()};else s.products.splice(index,1);});
        return json({ok:true});
      }
      if(path==='/api/admin/upload'&&req.method==='POST'){
        const b=await body(req,4200000);if(typeof b.data!=='string')throw new ShopError('Foto inválida.');
        const bytes=Buffer.from(b.data,'base64');let ext;
        if(bytes.subarray(0,3).equals(Buffer.from([255,216,255])))ext='jpg';
        else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';
        else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')ext='webp';
        if(!ext||bytes.length>3000000)throw new ShopError('Envie JPG, PNG ou WebP com até 3 MB.');
        const filename=`${randomUUID()}.${ext}`;
        if(serverless)await store.saveAsset(`uploads/${filename}`,bytes,{'jpg':'image/jpeg','png':'image/png','webp':'image/webp'}[ext]);
        else{await mkdir(join(config.dataDir,'uploads'),{recursive:true});await writeFile(join(config.dataDir,'uploads',filename),bytes);}
        return json({url:`/uploads/${filename}`},201);
      }
      if(path==='/api/admin/settings'){
        if(req.method==='GET')return json({settings:(await store.read()).settings,paymentsReady:ready()});
        if(req.method==='PUT'){
          const b=await body(req);if(!Number.isSafeInteger(b.deliveryFee)||b.deliveryFee<0||b.deliveryFee>100000)throw new ShopError('Taxa de entrega inválida.');
          const settings={storeName:'Café & Delícias',tagline:'Mãe e Filha',deliveryEnabled:b.deliveryEnabled===true,deliveryFee:b.deliveryFee,deliveryArea:text(b.deliveryArea||'',0,200,'Área de entrega'),pickupAddress:text(b.pickupAddress||'',0,300,'Retirada'),hours:text(b.hours||'',0,200,'Horário'),whatsapp:String(b.whatsapp||'').replace(/\D/g,''),catalogExample:b.catalogExample===true};
          if(settings.deliveryEnabled&&!settings.deliveryArea)throw new ShopError('Informe os bairros ou a região atendida.');
          if(settings.whatsapp&&!/^\d{10,13}$/.test(settings.whatsapp))throw new ShopError('WhatsApp inválido.');
          await store.update(s=>{s.settings=settings;});return json({ok:true});
        }
      }
      if(path==='/api/admin/orders'&&req.method==='GET')return json({orders:(await store.read()).orders.map(({key,fingerprint,receiptToken,...o})=>o)});
      const syncMatch=path.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/sync$/);
      if(syncMatch&&req.method==='POST'){
        const o=(await store.read()).orders.find(o=>o.id===syncMatch[1]);if(!o)throw new ShopError('Pedido não encontrado.',404);
        const payments=await mp(`/v1/payments/search?external_reference=${encodeURIComponent(o.id)}&sort=date_created&criteria=desc`);
        // Process the approved attempt first when multiple attempts exist.
        const list=[...(payments.results||[])].sort((a,b)=>(b.status==='approved')-(a.status==='approved'));
        for(const p of list)await reconcile(p.id);return json({ok:true});
      }
      if(path==='/api/admin/backup'&&req.method==='GET'){
        const {admin,sessions,loginAttempts,...data}=await store.read();res.setHeader('Content-Disposition','attachment; filename="backup-delicias.json"');return json(data);
      }
      if(path==='/api/checkout'&&req.method==='POST'){
        if(!ready())throw new ShopError('Os pagamentos ainda não foram ativados pela loja. Nenhuma cobrança foi realizada.',503);
        const b=await body(req,20000);if(!['pix','boleto','credit','debit'].includes(b.method))throw new ShopError('Selecione o pagamento.');
        if(!/^[a-f0-9-]{32,64}$/.test(b.key||''))throw new ShopError('Identificação do checkout inválida.');
        const customer=customerInput(b);
        const fingerprint=createHash('sha256').update(JSON.stringify({items:b.items,fulfillment:b.fulfillment,method:b.method,customer})).digest('hex');
        let order=await store.update(s=>{
          if(s.settings.catalogExample)throw new ShopError('A loja está em demonstração. O catálogo real precisa ser publicado antes de receber pedidos.',503);
          if(!s.settings.pickupAddress)throw new ShopError('A loja precisa configurar o endereço de retirada antes de receber pedidos.',503);
          const previous=s.orders.find(o=>o.key===b.key);
          if(previous){if(previous.fingerprint!==fingerprint)throw new ShopError('Seu pedido foi alterado. Atualize a sacola.',409);return previous;}
          const q=quote(s,b);const o={...q,id:randomUUID(),key:b.key,fingerprint,receiptToken:randomBytes(24).toString('hex'),customer,fulfillment:b.fulfillment,method:b.method,status:'creating',createdAt:new Date().toISOString()};
          for(const i of q.items)s.products.find(p=>p.id===i.id).stock-=i.quantity;
          s.orders.unshift(o);return o;
        });
        if(order.checkoutUrl)return json({id:order.id,url:order.checkoutUrl,receiptToken:order.receiptToken});
        if(order.status!=='creating')throw new ShopError('Este pedido não pode ser reenviado. Atualize sua sacola.',409);
        const returnUrl=`${config.baseUrl}/?pedido=${order.id}&chave=${order.receiptToken}`;
        const selected={pix:'bank_transfer',boleto:'ticket',credit:'credit_card',debit:'debit_card'}[b.method];
        try{
          const finishPayment=async()=>{
          const preference=await mp('/checkout/preferences',{method:'POST',headers:{'X-Idempotency-Key':order.id},body:JSON.stringify({
            items:[...order.items.map(i=>({id:i.id,title:i.name,currency_id:'BRL',quantity:i.quantity,unit_price:i.price/100})),...(order.deliveryFee?[{id:'entrega',title:'Entrega',currency_id:'BRL',quantity:1,unit_price:order.deliveryFee/100}]:[])],
            payer:{name:customer.name,email:customer.email},external_reference:order.id,
            back_urls:{success:returnUrl,pending:returnUrl,failure:returnUrl},auto_return:'approved',notification_url:`${config.baseUrl}/api/payments/webhook`,
            payment_methods:{excluded_payment_types:['credit_card','debit_card','ticket','bank_transfer','atm'].filter(t=>t!==selected).map(id=>({id})),...(b.method==='pix'?{default_payment_method_id:'pix'}:{})},
            expires:true,expiration_date_to:new Date(Date.now()+24*3600000).toISOString(),statement_descriptor:'CAFE E DELICIAS'
          })});
          const checkout=preference.init_point;
          if(!checkout||!/^https:\/\/(?:[a-z0-9-]+\.)?mercadopago\.com(?:\.br)?\//.test(checkout))throw new ShopError('Endereço de pagamento inválido.',502);
          await store.update(s=>{const o=s.orders.find(o=>o.id===order.id);o.preferenceId=preference.id;o.checkoutUrl=checkout;if(o.status==='creating')o.status='pending';});
          return {id:order.id,url:checkout,receiptToken:order.receiptToken};
          };
          let flight=checkoutFlights.get(order.id);
          if(!flight){flight=finishPayment();checkoutFlights.set(order.id,flight);}
          try{return json(await flight);}finally{if(checkoutFlights.get(order.id)===flight)checkoutFlights.delete(order.id);}
        }catch(e){
          // A timeout may mean the provider created a preference. Keep the order
          // and its stock reservation; a retry reuses the same idempotency key.
          if(!(e instanceof ShopError))throw new ShopError('O pagamento demorou a responder. Tente novamente para retomar o mesmo pedido.',502);
          throw e;
        }
      }
      if(path==='/api/payments/webhook'&&req.method==='POST'){
        if(!ready())throw new ShopError('Pagamentos não configurados.',503);
        const b=await body(req,20000);if(b.type!=='payment')return json({received:true});
        const id=url.searchParams.get('data.id');const parts=Object.fromEntries(String(req.headers['x-signature']||'').split(',').map(p=>p.trim().split('=')));
        const requestId=req.headers['x-request-id'];if(!id||!requestId||!parts.ts||!/^\d+$/.test(parts.ts)||!/^\d+$/.test(id))throw new ShopError('Assinatura inválida.',401);
        const signature=createHmac('sha256',config.webhookSecret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${parts.ts};`).digest('hex');
        if(!secureEqual(signature,parts.v1))throw new ShopError('Assinatura inválida.',401);
        await reconcile(id);return json({received:true});
      }
      const orderMatch=path.match(/^\/api\/orders\/([a-f0-9-]+)$/);
      if(orderMatch&&req.method==='GET'){
        const o=(await store.read()).orders.find(o=>o.id===orderMatch[1]&&secureEqual(o.receiptToken,url.searchParams.get('key')));
        if(!o)throw new ShopError('Pedido não encontrado.',404);return json({order:publicOrder(o)});
      }
      if(path.startsWith('/api/'))throw new ShopError('Rota não encontrada.',404);
      if(req.method!=='GET'&&req.method!=='HEAD')throw new ShopError('Método não permitido.',405);
      const allowed=new Map([['/','index.html'],['/admin','admin.html'],['/admin/','admin.html'],['/style.css','style.css'],['/app.js','app.js'],['/admin.js','admin.js'],['/marca.jpeg','marca.jpeg'],['/favicon.svg','favicon.svg']]);
      let filename=allowed.has(path)?join(root,'public',allowed.get(path)):null;
      if(/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(path))filename=join(config.dataDir,path.slice(1));
      if(!filename)throw new ShopError('Página não encontrada.',404);
      let content;try{content=serverless&&path.startsWith('/uploads/')?await store.readAsset(path.slice(1)):await readFile(filename);if(!content)throw new ShopError('Arquivo não encontrado.',404);}catch(e){if(e.code==='ENOENT')throw new ShopError('Arquivo não encontrado.',404);throw e;}
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[extname(filename)],'Cache-Control':path.startsWith('/uploads/')?'public, max-age=86400':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json({error:e instanceof ShopError?e.message:'Ocorreu um erro. Tente novamente.'},e.status||500);else res.end();if(!(e instanceof ShopError)&&!options.quiet)console.error('Falha interna:',e.code||e.name);}
  });
  return app;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\','/')}`))) {
  // Optional local .env uses Node's built-in parser when available (Node 20.12+).
  try{process.loadEnvFile?.(join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const dataDir=process.env.DATA_DIR||join(root,'data');await mkdir(dataDir,{recursive:true});
  let lock;try{lock=await open(join(dataDir,'.server.lock'),'wx');await lock.writeFile(String(process.pid));}
  catch{console.error('Já existe um servidor usando este banco. Se ele foi encerrado de forma abrupta, remova data/.server.lock antes de reiniciar.');process.exit(1);}
  const app=await createApp();const port=Number(process.env.PORT||3180),host=process.env.HOST||'127.0.0.1';
  app.on('error',async error=>{await lock.close();const {unlink}=await import('node:fs/promises');await unlink(join(dataDir,'.server.lock')).catch(()=>{});console.error(error.code==='EADDRINUSE'?`A porta ${port} está em uso. Configure PORT com outra porta no arquivo .env.`:`Não foi possível iniciar o servidor: ${error.code}`);process.exit(1);});
  app.listen(port,host,()=>console.log(`Café & Delícias: http://${host}:${port}`));
  const stop=async()=>{app.close();await lock.close();const {unlink}=await import('node:fs/promises');await unlink(join(dataDir,'.server.lock')).catch(()=>{});process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
