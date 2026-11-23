import http from 'node:http';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHmac,createHash} from 'node:crypto';
import {FileStore} from './lib/store.mjs';
import {BlobStore} from './lib/blob-store.mjs';
import {ShopError,text,validateProduct,quote,customerInput,categories} from './lib/shop.mjs';
import {orderReport,orderReceipt} from './lib/order-reports.mjs';
import {paymentType,supportsAmount,transparentPaymentInput} from './lib/transparent-payment.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const secureEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const hash=(p,s)=>scryptSync(p,s,64).toString('hex');
const publicOrder=o=>({id:o.id,createdAt:o.createdAt,status:o.status,fulfillment:o.fulfillment,items:o.items,subtotal:o.subtotal,deliveryFee:o.deliveryFee,total:o.total,method:o.method,checkoutUrl:o.checkoutUrl||null,
  ...(o.transparentCheckout&&o.status==='pending'&&o.paymentId&&['pix','boleto'].includes(o.method)?{paymentId:o.paymentId}:{})});
const checkoutReceipt=o=>({id:o.id,receiptToken:o.receiptToken,status:o.status});
const paymentStatuses={approved:'paid',refunded:'refunded',charged_back:'charged_back',cancelled:'cancelled',rejected:'rejected',pending:'pending',in_process:'pending',authorized:'pending',in_mediation:'in_mediation'};
const shopCsp="default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const paymentCsp=shopCsp
  .replace("script-src 'self'","script-src 'self' https://sdk.mercadopago.com https://http2.mlstatic.com")
  .replace("style-src 'self'","style-src 'self' 'unsafe-inline' https://http2.mlstatic.com")
  .replace("font-src 'self'","font-src 'self' https://http2.mlstatic.com")
  .replace("connect-src 'self'","connect-src 'self' https://*.mercadopago.com https://*.mercadopago.com.br https://*.mercadolibre.com https://*.mlstatic.com")+
  '; frame-src https://*.mercadopago.com https://*.mercadopago.com.br https://*.mercadolibre.com';

function checkoutAvailable(state) {
  if(state.settings.catalogExample)throw new ShopError('A loja está em demonstração. O catálogo real precisa ser publicado antes de receber pedidos.',503);
  if(!state.settings.pickupAddress)throw new ShopError('A loja precisa configurar o endereço de retirada antes de receber pedidos.',503);
}

function releasePaymentStock(state,order) {
  if(order.stockReleased)return;
  for(const item of order.items){
    const product=state.products.find(product=>product.id===item.id);
    if(product)product.stock+=item.quantity;
  }
  order.stockReleased=true;
}

export async function createApp(options={}) {
  const serverless=options.serverless??Boolean(process.env.VERCEL);
  const origin=process.env.PUBLIC_BASE_URL||(process.env.VERCEL_PROJECT_PRODUCTION_URL?`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`:undefined);
  const config={dataDir:process.env.DATA_DIR||join(root,'data'),adminPassword:process.env.ADMIN_PASSWORD,
    accessToken:process.env.MP_ACCESS_TOKEN,webhookSecret:process.env.MP_WEBHOOK_SECRET,baseUrl:origin,
    transparentPublicKey:process.env.MP_TRANSPARENT_PUBLIC_KEY,transparentAccessToken:process.env.MP_TRANSPARENT_ACCESS_TOKEN,
    transparentWebhookSecret:process.env.MP_TRANSPARENT_WEBHOOK_SECRET,...options};
  const adminUsername=(options.adminUsername??process.env.ADMIN_USERNAME)?.trim()||'admin';
  if(adminUsername.length>100)throw new Error('ADMIN_USERNAME precisa ter no máximo 100 caracteres.');
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
      const content=`Acesso ao painel /admin\nUsuário inicial: ${adminUsername}\nSenha: ${password}\nGuarde este arquivo em local seguro.\n`;
      if(serverless)await store.saveAsset('system/acesso-admin.txt',content,'text/plain');
      else await writeFile(join(config.dataDir,'acesso-admin.txt'),content,{mode:0o600});
    }
  }
  if(!options.quiet)console.log(serverless?'Painel /admin: acesso inicial no Blob privado system/acesso-admin.txt.':'Painel /admin: use a senha configurada ou consulte data/acesso-admin.txt.');
  const publicHttps=config.baseUrl?.startsWith('https://');
  const ready=()=>Boolean(config.accessToken&&config.webhookSecret&&publicHttps);
  const transparentWebhookReady=()=>Boolean(config.transparentAccessToken&&config.transparentWebhookSecret&&publicHttps);
  const transparentReady=()=>Boolean(config.transparentPublicKey&&transparentWebhookReady());
  async function mp(path,init={},transparent=false) {
    const accessToken=transparent?config.transparentAccessToken:config.accessToken;
    const response=await (options.paymentFetch||fetch)(`https://api.mercadopago.com${path}`,{...init,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(20000)});
    if(!response.ok){
      if((path==='/checkout/preferences'||path==='/v1/payments')&&!options.quiet){
        const details=await response.json().catch(()=>null);
        const codes=[details?.error,details?.code].filter(code=>typeof code==='string'&&/^[a-z][a-z0-9_]{0,79}$/i.test(code));
        console.warn(transparent?'Mercado Pago recusou o pagamento':'Mercado Pago recusou a criação da preferência',{status:response.status,codes});
      }
      const error=new ShopError('Não foi possível acessar o pagamento. Tente novamente em instantes.',502);
      error.providerStatus=response.status;
      throw error;
    }
    return response.json();
  }
  async function recordPayment(p,transparent=false) {
    return store.update(s=>{
      const o=s.orders.find(o=>o.id===p.external_reference);
      if(!o||Boolean(o.transparentCheckout)!==transparent)return;
      if(p.currency_id!=='BRL'||Math.round(Number(p.transaction_amount)*100)!==o.total) throw new ShopError('Valor do pagamento não corresponde ao pedido.',409);
      if(transparent&&p.payment_type_id!==paymentType(o.method))throw new ShopError('Meio de pagamento não corresponde ao pedido.',409);
      if(['paid','refunded','charged_back'].includes(o.status)&&o.paymentId&&String(o.paymentId)!==String(p.id))return o;
      // Never downgrade an approved payment because of a delayed pending notification.
      const next=Object.hasOwn(paymentStatuses,p.status)?paymentStatuses[p.status]:null;
      if(!next||!/^\d{1,30}$/.test(String(p.id)))return o;
      if(['paid','refunded','charged_back'].includes(o.status)&&['pending','cancelled','rejected'].includes(next))return o;
      if(transparent&&o.stockReleased)return o;
      const reconciledId=String(p.id);
      if(o.paymentId!==reconciledId){
        delete o.paymentType;
        delete o.installments;
      }
      if(typeof p.payment_type_id==='string'&&/^[a-z_]{1,40}$/.test(p.payment_type_id))o.paymentType=p.payment_type_id;
      if(Number.isSafeInteger(p.installments)&&p.installments>0)o.installments=p.installments;
      o.paymentId=reconciledId;o.status=next;o.updatedAt=new Date().toISOString();
      if(transparent&&['cancelled','rejected'].includes(next))releasePaymentStock(s,o);
      return o;
    });
  }
  async function reconcile(paymentId,transparent=false) {
    const payment=await mp(`/v1/payments/${encodeURIComponent(paymentId)}`,{},transparent);
    return recordPayment(payment,transparent);
  }
  async function reserveCheckout(b,customer,{transparent=false,expectedTotal}={}) {
    const fingerprint=createHash('sha256').update(JSON.stringify({items:b.items,fulfillment:b.fulfillment,method:b.method,customer})).digest('hex');
    return store.update(s=>{
      checkoutAvailable(s);
      const previous=s.orders.find(o=>o.key===b.key);
      if(previous){
        if(previous.fingerprint!==fingerprint||Boolean(previous.transparentCheckout)!==transparent||
            (transparent&&previous.total!==expectedTotal))throw new ShopError('Seu pedido foi alterado. Atualize a sacola.',409);
        return {order:previous,created:false};
      }
      const q=quote(s,b);
      if(transparent&&q.total!==expectedTotal)throw new ShopError('O valor do pedido mudou. Volte para conferir o total.',409);
      const order={...q,id:randomUUID(),key:b.key,fingerprint,receiptToken:randomBytes(24).toString('hex'),customer,
        fulfillment:b.fulfillment,method:b.method,status:'creating',createdAt:new Date().toISOString(),...(transparent?{transparentCheckout:true}:{})};
      for(const item of q.items)s.products.find(p=>p.id===item.id).stock-=item.quantity;
      s.orders.unshift(order);
      return {order,created:true};
    });
  }

  let paymentMethods,paymentMethodsUntil=0;
  async function acceptedPaymentMethods(method,total) {
    if(Date.now()>=paymentMethodsUntil){
      const methods=await mp('/v1/payment_methods',{},true);
      if(!Array.isArray(methods))throw new ShopError('Não foi possível consultar os meios de pagamento. Tente novamente.',502);
      paymentMethods=methods;
      paymentMethodsUntil=Date.now()+300000;
    }
    const offlineId=method==='pix'?'pix':method==='boleto'?'bolbradesco':null;
    const available=paymentMethods.filter(type=>type.status==='active'&&type.payment_type_id===paymentType(method)&&
      (!offlineId||type.id===offlineId));
    if(!available.length)throw new ShopError('Esta forma de pagamento não está disponível. Escolha outra opção.',400);
    const accepted=available.filter(type=>supportsAmount(type,total));
    if(!accepted.length){
      const minimum=Math.min(...available.map(type=>Number(type.min_allowed_amount||0)));
      if(total/100<minimum)throw new ShopError(`O valor mínimo para essa forma de pagamento é ${minimum.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}.`,400);
      throw new ShopError('Este valor não está disponível para essa forma de pagamento.',400);
    }
    return accepted;
  }
  async function body(req,max=3000000) {
    if(req.body!==undefined){const data=typeof req.body==='string'?req.body:JSON.stringify(req.body);if(Buffer.byteLength(data)>max)throw new ShopError('Solicitação muito grande.',413);try{return JSON.parse(data);}catch{throw new ShopError('Dados inválidos.');}}
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>max)throw new ShopError('Arquivo ou solicitação muito grande.',413);chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new ShopError('Dados inválidos.');}
  }
  const app=http.createServer(async(req,res)=>{
    const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const printable=html=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);};
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',shopCsp);
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const transparentWebhook=path==='/api/payments/transparent-webhook';
      const webhook=transparentWebhook||path==='/api/payments/webhook';
      if(path==='/'&&transparentReady())res.setHeader('Content-Security-Policy',paymentCsp);
      const client=serverless?String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||'unknown').split(',')[0].trim():req.socket.remoteAddress,now=Date.now();
      if(requestLimits.size>10000)requestLimits.clear();
      const rate=requestLimits.get(client)||{time:now,count:0};if(now-rate.time>60000){rate.time=now;rate.count=0;}requestLimits.set(client,rate);
      if(++rate.count>300)throw new ShopError('Muitas solicitações. Aguarde um minuto.',429);
      const cookies=String(req.headers.cookie||'').split(';').map(c=>c.trim().split('='));
      const token=cookies.find(([k])=>k==='delicias_session')?.[1];
      const tokenHash=token&&createHash('sha256').update(token).digest('hex');
      const session=tokenHash&&(await store.read()).sessions?.[tokenHash];const admin=Boolean(session&&session.expires>now);
      if(path.startsWith('/api/admin/')&&!admin)throw new ShopError('Entre no painel para continuar.',401);
      if(path.startsWith('/api/')&&!['GET','HEAD'].includes(req.method)&&!webhook) {
        // Vercel routes each registered alias to this project. Compare against
        // the actual request host, rather than the canonical payment-return URL.
        // Forwarded host headers are deliberately not trusted here.
        const host=req.headers.host;
        if(serverless&&(typeof host!=='string'||! /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)))throw new ShopError('Solicitação não autorizada.',403);
        const expected=serverless?new URL(`https://${host}`).origin:config.baseUrl?new URL(config.baseUrl).origin:`http://${host}`;
        if(req.headers['x-shop-request']!=='1'||(req.headers.origin&&req.headers.origin!==expected))throw new ShopError('Solicitação não autorizada.',403);
      }
      if(path==='/api/session'&&req.method==='GET')return json({authenticated:admin,paymentsReady:ready()||transparentReady(),hosted:serverless});
      if(path==='/api/login'&&req.method==='POST'){
        const addressHash=createHash('sha256').update(client||'unknown').digest('hex');
        const allowed=await store.update(s=>{s.loginAttempts??={};for(const [key,a] of Object.entries(s.loginAttempts))if(now-a.time>900000)delete s.loginAttempts[key];const a=s.loginAttempts[addressHash]??={time:now,count:0};return ++a.count<=8;});
        if(!allowed)throw new ShopError('Muitas tentativas. Aguarde 15 minutos.',429);
        const b=await body(req,2000);const s=await store.read();
        const validPassword=typeof b.password==='string'&&b.password.length<=200&&secureEqual(hash(b.password,s.admin.salt),s.admin.hash);
        const validUsername=typeof b.username==='string'&&secureEqual(b.username.trim(),adminUsername);
        if(!validUsername||!validPassword)throw new ShopError('Usuário ou senha incorretos.',401);
        const value=randomBytes(32).toString('hex'),sessionKey=createHash('sha256').update(value).digest('hex');
        await store.update(s=>{delete s.loginAttempts?.[addressHash];s.sessions??={};for(const [key,v] of Object.entries(s.sessions))if(v.expires<now)delete s.sessions[key];s.sessions[sessionKey]={expires:now+12*3600000};});
        res.setHeader('Set-Cookie',`delicias_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${serverless||config.baseUrl?.startsWith('https:')?'; Secure':''}`);
        return json({ok:true});
      }
      if(path==='/api/logout'&&req.method==='POST'){if(tokenHash)await store.update(s=>{delete s.sessions?.[tokenHash];});res.setHeader('Set-Cookie','delicias_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json({ok:true});}
      if(path==='/api/catalog'&&req.method==='GET'){
        const s=await store.read();return json({products:s.products.filter(p=>p.active),settings:s.settings,categories,
          paymentsReady:ready()||transparentReady(),paymentPublicKey:transparentReady()?config.transparentPublicKey:null});
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
        if(req.method==='GET')return json({settings:(await store.read()).settings,paymentsReady:ready()||transparentReady()});
        if(req.method==='PUT'){
          const b=await body(req);if(!Number.isSafeInteger(b.deliveryFee)||b.deliveryFee<0||b.deliveryFee>100000)throw new ShopError('Taxa de entrega inválida.');
          const settings={storeName:'Dois Amores Doceria',tagline:'Mãe e Filha',deliveryEnabled:b.deliveryEnabled===true,deliveryFee:b.deliveryFee,deliveryArea:text(b.deliveryArea||'',0,200,'Área de entrega'),pickupAddress:text(b.pickupAddress||'',0,300,'Retirada'),hours:text(b.hours||'',0,200,'Horário'),whatsapp:String(b.whatsapp||'').replace(/\D/g,''),catalogExample:b.catalogExample===true};
          if(settings.deliveryEnabled&&!settings.deliveryArea)throw new ShopError('Informe os bairros ou a região atendida.');
          if(settings.whatsapp&&!/^\d{10,13}$/.test(settings.whatsapp))throw new ShopError('WhatsApp inválido.');
          await store.update(s=>{s.settings=settings;});return json({ok:true});
        }
      }
      if(path==='/api/admin/orders'&&req.method==='GET')return json({orders:(await store.read()).orders.map(({key,fingerprint,receiptToken,...o})=>o)});
      if(path==='/api/admin/orders/report'&&req.method==='GET'){
        return printable(orderReport((await store.read()).orders,url.searchParams));
      }
      const receiptMatch=path.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/receipt$/);
      if(receiptMatch&&req.method==='GET'){
        const order=(await store.read()).orders.find(order=>order.id===receiptMatch[1]);
        if(!order)throw new ShopError('Pedido não encontrado.',404);
        return printable(orderReceipt(order,url.searchParams.get('paper')));
      }
      const syncMatch=path.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/sync$/);
      if(syncMatch&&req.method==='POST'){
        const o=(await store.read()).orders.find(o=>o.id===syncMatch[1]);if(!o)throw new ShopError('Pedido não encontrado.',404);
        const transparent=Boolean(o.transparentCheckout);
        if(transparent&&!transparentWebhookReady())throw new ShopError('A consulta de pagamentos não está configurada.',503);
        const payments=await mp(`/v1/payments/search?external_reference=${encodeURIComponent(o.id)}&sort=date_created&criteria=desc`,{},transparent);
        // Process the approved attempt first when multiple attempts exist.
        const list=[...(payments.results||[])].sort((a,b)=>(b.status==='approved')-(a.status==='approved'));
        for(const p of list)await reconcile(p.id,transparent);return json({ok:true});
      }
      if(path==='/api/admin/backup'&&req.method==='GET'){
        const {admin,sessions,loginAttempts,...data}=await store.read();res.setHeader('Content-Disposition','attachment; filename="backup-delicias.json"');return json(data);
      }
      if((path==='/api/checkout/transparent/quote'||path==='/api/checkout/transparent')&&req.method==='POST'){
        if(!transparentReady())throw new ShopError('O checkout na loja ainda não está disponível.',503);
        const b=await body(req,20000);
        if(!paymentType(b?.method))throw new ShopError('Selecione o pagamento.');
        if(typeof b.key!=='string'||!/^[a-f0-9-]{32,64}$/.test(b.key))throw new ShopError('Identificação do checkout inválida.');
        const customer=customerInput(b);

        if(path==='/api/checkout/transparent/quote'){
          const state=await store.read();
          checkoutAvailable(state);
          const {total}=quote(state,b);
          const accepted=await acceptedPaymentMethods(b.method,total);
          return json({total,paymentMethodIds:accepted.map(method=>method.id)});
        }

        const {expectedTotal}=b;
        if(!Number.isSafeInteger(expectedTotal)||expectedTotal<1)throw new ShopError('Confira o total do pedido.');
        const paymentInput=transparentPaymentInput(b.payment,b.method,customer);
        const eligible=await acceptedPaymentMethods(b.method,expectedTotal);
        if(!eligible.some(type=>type.id===paymentInput.payment_method_id))throw new ShopError('Este meio de pagamento não está disponível para o pedido.');
        const {order,created}=await reserveCheckout(b,customer,{transparent:true,expectedTotal});
        if(!created)return json(checkoutReceipt(order));

        try {
          const payment=await mp('/v1/payments',{
            method:'POST',headers:{'X-Idempotency-Key':order.id},body:JSON.stringify({
              ...paymentInput,transaction_amount:order.total/100,description:'Dois Amores Doceria',
              external_reference:order.id,notification_url:`${config.baseUrl}/api/payments/transparent-webhook?source_news=webhooks`,
            }),
          },true);
          const updated=payment.external_reference===order.id?await recordPayment(payment,true):null;
          return json(checkoutReceipt(updated||order));
        } catch(error) {
          // A timeout or a provider failure may occur after the payment was accepted.
          // Keep its reservation and let the webhook or admin reconcile the attempt.
          if(![400,401,403,422].includes(error.providerStatus)){
            if(!options.quiet)console.warn('Pagamento aguardando conciliação', {orderId:order.id, status:error.providerStatus});
            return json(checkoutReceipt(order));
          }
          const rejected=await store.update(state=>{
            const currentOrder=state.orders.find(saved=>saved.id===order.id);
            if(currentOrder.status==='creating'){
              currentOrder.status='rejected';
              currentOrder.updatedAt=new Date().toISOString();
              releasePaymentStock(state,currentOrder);
            }
            return currentOrder;
          });
          return json(checkoutReceipt(rejected));
        }
      }
      if(path==='/api/checkout'&&req.method==='POST'){
        if(!ready())throw new ShopError('Os pagamentos ainda não foram ativados pela loja. Nenhuma cobrança foi realizada.',503);
        const b=await body(req,20000);if(!['pix','boleto','credit','debit'].includes(b.method))throw new ShopError('Selecione o pagamento.');
        if(!/^[a-f0-9-]{32,64}$/.test(b.key||''))throw new ShopError('Identificação do checkout inválida.');
        if(transparentReady())throw new ShopError('Atualize a página para pagar no checkout da loja.',409);
        const customer=customerInput(b);
        const {order}=await reserveCheckout(b,customer);
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
      if(webhook&&req.method==='POST'){
        if(!(transparentWebhook?transparentWebhookReady():ready()))throw new ShopError('Pagamentos não configurados.',503);
        const b=await body(req,20000);if(b.type!=='payment')return json({received:true});
        const id=url.searchParams.get('data.id');const parts=Object.fromEntries(String(req.headers['x-signature']||'').split(',').map(p=>p.trim().split('=')));
        const requestId=req.headers['x-request-id'];if(!id||!requestId||!parts.ts||!/^\d+$/.test(parts.ts)||!/^\d+$/.test(id))throw new ShopError('Assinatura inválida.',401);
        const secret=transparentWebhook?config.transparentWebhookSecret:config.webhookSecret;
        const signature=createHmac('sha256',secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${parts.ts};`).digest('hex');
        if(!secureEqual(signature,parts.v1))throw new ShopError('Assinatura inválida.',401);
        await reconcile(id,transparentWebhook);return json({received:true});
      }
      const orderMatch=path.match(/^\/api\/orders\/([a-f0-9-]+)$/);
      if(orderMatch&&req.method==='GET'){
        const o=(await store.read()).orders.find(o=>o.id===orderMatch[1]&&secureEqual(o.receiptToken,url.searchParams.get('key')));
        if(!o)throw new ShopError('Pedido não encontrado.',404);return json({order:publicOrder(o)});
      }
      if(path.startsWith('/api/'))throw new ShopError('Rota não encontrada.',404);
      if(req.method!=='GET'&&req.method!=='HEAD')throw new ShopError('Método não permitido.',405);
      const allowed=new Map([['/','index.html'],['/admin','admin.html'],['/admin/','admin.html'],['/style.css','style.css'],['/app.js','app.js'],['/admin.js','admin.js'],['/marca.jpeg','marca.jpeg'],['/favicon.svg','favicon.svg'],['/dois-amores-doceria-cabecalho.png','dois-amores-doceria-cabecalho.png']]);
      allowed.set('/order-print.css','order-print.css');
      allowed.set('/order-print.js','order-print.js');
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
  app.listen(port,host,()=>console.log(`Dois Amores Doceria: http://${host}:${port}`));
  const stop=async()=>{app.close();await lock.close();const {unlink}=await import('node:fs/promises');await unlink(join(dataDir,'.server.lock')).catch(()=>{});process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
