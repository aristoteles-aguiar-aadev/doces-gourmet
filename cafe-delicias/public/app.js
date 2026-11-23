const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const money=n=>(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=id=>`<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
let catalog={products:[],settings:{},categories:[],paymentsReady:false}, category='Todos',toastTimer,checkoutKey=crypto.randomUUID(),cart=[];
const paymentOptions={
  pix:{label:'Pix',method:'bankTransfer',form:'bankTransferForm'},
  boleto:{label:'Boleto',method:'ticket',form:'ticketForm'},
  credit:{label:'Crédito',method:'creditCard',form:'creditCardForm'},
  debit:{label:'Débito',method:'debitCard',form:'debitCardForm'},
};
let paymentSdk, paymentBrick, paymentVersion=0, paymentSubmitting=false;
let statusBrick, statusVersion=0;
try{const saved=JSON.parse(localStorage.getItem('delicias-cart-v1')||'[]');if(Array.isArray(saved))cart=saved.filter(i=>typeof i.id==='string'&&Number.isInteger(i.quantity)&&i.quantity>0&&i.quantity<=99).slice(0,50);}catch{}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3600);}
function saveCart(){try{localStorage.setItem('delicias-cart-v1',JSON.stringify(cart));}catch{}checkoutKey=crypto.randomUUID();updateCount();}
function updateCount(){const n=cart.reduce((n,i)=>n+i.quantity,0);$('#cart-count').textContent=n;$('#open-cart').setAttribute('aria-label',`Abrir sacola, ${n} ${n===1?'item':'itens'}`);}
async function api(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Shop-Request':'1',...options.headers}});let data;try{data=await r.json();}catch{throw new Error('Não foi possível acessar a loja. Tente novamente.');}if(!r.ok)throw new Error(data.error||'Não foi possível continuar.');return data;}
function imageFallback(img){img.addEventListener('error',()=>{if(!img.src.endsWith('/marca.jpeg')){img.src='/marca.jpeg';img.alt='Dois Amores Doceria — imagem ilustrativa';}},{once:true});}
function images(parent=document){parent.querySelectorAll('img').forEach(imageFallback);}
async function loadCatalog(){catalog=await api('/api/catalog');renderCategories();renderProducts();renderSettings();updateCount();}
function renderCategories(){const list=['Todos',...catalog.categories.filter(c=>catalog.products.some(p=>p.category===c))];if(!list.includes(category))category='Todos';$('#categories').innerHTML=list.map(c=>`<button class="category-pill" data-category="${esc(c)}" aria-pressed="${c===category}">${esc(c)}</button>`).join('');}
function renderProducts(){
  const term=$('#search').value.trim().toLocaleLowerCase('pt-BR');
  let list=catalog.products.filter(p=>(category==='Todos'||p.category===category)&&`${p.name} ${p.description} ${p.category}`.toLocaleLowerCase('pt-BR').includes(term));
  const sort=$('#sort').value;if(sort==='price-asc')list.sort((a,b)=>a.price-b.price);else if(sort==='price-desc')list.sort((a,b)=>b.price-a.price);else if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));else list.sort((a,b)=>Number(b.featured)-Number(a.featured));
  $('#results-label').textContent=`${list.length} ${list.length===1?'delícia para você':'delícias para você'}`;
  $('#products').innerHTML=list.length?list.map(p=>`<article class="product-card"><div class="product-photo"><button class="product-image-button" data-detail="${esc(p.id)}" aria-label="Ver detalhes de ${esc(p.name)}"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"></button>${p.stock===0?'<span class="product-badge sold">ESGOTADO POR HOJE</span>':p.featured?'<span class="product-badge">♡ &nbsp; QUERIDINHO DA CASA</span>':''}</div><div class="product-info"><span class="product-category">${esc(p.category)}</span><h3><button class="product-name-button" data-detail="${esc(p.id)}">${esc(p.name)}</button></h3><p>${esc(p.description)}</p><div class="product-bottom"><span class="product-price">${money(p.price)}<small>${esc(p.unit)}</small></span><button class="add-button" data-add="${esc(p.id)}" ${p.stock===0?'disabled':''} aria-label="Adicionar ${esc(p.name)} à sacola">${icon('plus')}</button></div></div></article>`).join(''):`<div class="empty-state">${icon('search')}<h3>Nenhuma delícia por aqui</h3><p>Tente outro nome ou explore todo o cardápio.</p><button class="button secondary" id="reset-search">Ver todas as delícias</button></div>`;
  images($('#products'));
}
function renderSettings(){const s=catalog.settings;$('#example-note').hidden=!s.catalogExample;$('#year').textContent=new Date().getFullYear();$('#contact-info').textContent=s.pickupAddress||'Informações de contato em breve.';$('#hours-info').textContent=s.hours||'';$('#whatsapp-link').hidden=!s.whatsapp;if(s.whatsapp)$('#whatsapp-link').href=`https://wa.me/${s.whatsapp.startsWith('55')?s.whatsapp:'55'+s.whatsapp}`;}
function add(id){const p=catalog.products.find(p=>p.id===id);if(!p||p.stock<1)return toast('Este doce acabou por hoje.');const i=cart.find(i=>i.id===id);if((i?.quantity||0)>=Math.min(p.stock,99))return toast('Você já adicionou todas as unidades disponíveis.');if(i)i.quantity++;else cart.push({id,quantity:1});saveCart();toast(`${p.name} adicionado à sacola ♡`);if($('#cart-dialog').open)renderCart();}
function cartItems(){return cart.map(i=>({...i,product:catalog.products.find(p=>p.id===i.id)}));}
function subtotal(){return cartItems().reduce((n,i)=>n+(i.product?.price||0)*i.quantity,0);}
function renderCart(){
  if(!cart.length){$('#cart-content').innerHTML=`<div class="empty-state">${icon('bag')}<h3>Uma sacola cheia de possibilidades</h3><p>Que tal começar com um docinho?</p><button class="button primary" data-close="cart-dialog">Explorar o cardápio ${icon('arrow')}</button></div>`;return;}
  const invalid=cartItems().some(i=>!i.product||i.quantity>i.product.stock);
  $('#cart-content').innerHTML=`<div class="cart-items">${cartItems().map(i=>`<article class="cart-item"><img src="${esc(i.product?.image||'/marca.jpeg')}" alt="${esc(i.product?.name||'Produto indisponível')}"><div><h3>${esc(i.product?.name||'Produto indisponível')}</h3><span class="cart-item-price">${i.product?money(i.product.price*i.quantity):'Remova este item'}${i.product&&i.quantity>i.product.stock?' · estoque alterado':''}</span><div class="cart-item-bottom"><div class="quantity"><button data-quantity="${esc(i.id)}" data-delta="-1" aria-label="Diminuir quantidade">−</button><span>${i.quantity}</span><button data-quantity="${esc(i.id)}" data-delta="1" aria-label="Aumentar quantidade" ${!i.product||i.quantity>=i.product.stock?'disabled':''}>+</button></div><button class="text-button" data-remove="${esc(i.id)}">Remover</button></div></div></article>`).join('')}</div><div class="cart-footer"><div class="summary-line total"><strong>Subtotal</strong><strong>${money(subtotal())}</strong></div><p>Entrega, quando disponível, calculada na próxima etapa.</p>${invalid?'<div class="error-message">Alguns itens não estão mais disponíveis nessa quantidade. Ajuste a sacola para continuar.</div>':''}<button class="button primary full" id="go-checkout" ${invalid?'disabled':''}>Continuar meu pedido ${icon('arrow')}</button><span class="secure-note">${icon('shield')} Feito com carinho. Pago com segurança.</span></div>`;images($('#cart-content'));
}
function detail(id){const p=catalog.products.find(p=>p.id===id);if(!p)return;$('#product-detail').innerHTML=`<div class="detail-grid"><img class="detail-photo" src="${esc(p.image)}" alt="${esc(p.name)}"><div class="detail-copy"><span class="eyebrow">${esc(p.category)}</span><h2 id="detail-title">${esc(p.name)}</h2><p>${esc(p.description)}</p><p class="allergens"><strong>Ingredientes e alergênicos</strong><br>${esc(p.allergens||'Consulte a loja antes de comprar se você tem alguma restrição alimentar.')}</p><span class="product-price">${money(p.price)}<small>${esc(p.unit)} · ${p.stock} ${p.stock===1?'disponível':'disponíveis'}</small></span><button class="button primary full" data-add="${esc(p.id)}" ${p.stock===0?'disabled':''}>${p.stock===0?'Esgotado por hoje':'Adicionar à sacola'} ${icon('plus')}</button></div></div>`;images($('#product-detail'));$('#product-dialog').showModal();}
function checkoutSummary(){const form=$('#checkout-form'),delivery=form.elements.fulfillment.value==='delivery',fee=delivery?catalog.settings.deliveryFee:0;$('#address-field').hidden=!delivery;form.elements.address.required=delivery;$('#fulfillment-info').textContent=delivery?`Região atendida: ${catalog.settings.deliveryArea}. Taxa: ${money(fee)}. Confira se seu endereço está nessa região.`:catalog.settings.pickupAddress||'O endereço de retirada será informado pela loja antes da abertura dos pedidos.';$('#checkout-summary').innerHTML=cartItems().map(i=>`<div class="summary-item"><span>${esc(i.product?.name||'Indisponível')}<small>${i.quantity} × ${money(i.product?.price||0)}</small></span><strong>${money((i.product?.price||0)*i.quantity)}</strong></div>`).join('')+`<div class="summary-line"><span>Subtotal</span><span>${money(subtotal())}</span></div><div class="summary-line"><span>${delivery?'Entrega':'Retirada'}</span><span>${fee?money(fee):'Grátis'}</span></div><div class="summary-line total"><strong>Total</strong><strong>${money(subtotal()+fee)}</strong></div>`;}
async function checkout(){
  try{await loadCatalog();renderCart();if(!cart.length||cartItems().some(i=>!i.product||i.quantity>i.product.stock))return toast('Confira os itens e o estoque na sua sacola.');
    $('#cart-dialog').close();const form=$('#checkout-form');form.elements.fulfillment.value='pickup';form.elements.fulfillment[1].disabled=!catalog.settings.deliveryEnabled;
    const ready=catalog.paymentsReady&&!catalog.settings.catalogExample&&Boolean(catalog.settings.pickupAddress);$('#pay-button').disabled=!ready;
    $('#payment-help').textContent=catalog.paymentPublicKey?'Escolha uma forma de pagamento e continue na loja. A preparação começa após a confirmação do pagamento.':'Você concluirá o pagamento no ambiente do Mercado Pago.';
    $('#payment-notice').textContent=ready?'O pedido fica reservado enquanto você conclui o pagamento. O boleto depende de compensação bancária.':'Estamos preparando a loja para receber pedidos. Você pode conhecer o checkout; os pagamentos ainda não estão disponíveis e nenhuma cobrança será feita.';
    $('#checkout-error').hidden=true;checkoutSummary();$('#checkout-dialog').showModal();
  }catch(e){toast(e.message);}
}
$('#checkout-form').addEventListener('change',()=>{checkoutKey=crypto.randomUUID();checkoutSummary();});

function loadPaymentSdk(){
  if(window.MercadoPago)return Promise.resolve(window.MercadoPago);
  if(paymentSdk)return paymentSdk;
  paymentSdk=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://sdk.mercadopago.com/js/v2';
    function failed(){
      clearTimeout(timeout);
      script.remove();
      paymentSdk=undefined;
      reject(new Error('Não foi possível abrir o pagamento. Tente novamente.'));
    }
    const timeout=setTimeout(failed,15000);
    script.onerror=failed;
    script.onload=()=>{
      if(!window.MercadoPago)return failed();
      clearTimeout(timeout);
      resolve(window.MercadoPago);
    };
    document.head.append(script);
  });
  return paymentSdk;
}

function saveReceipt(result,transparent=false){
  try{sessionStorage.setItem('delicias-pedido',JSON.stringify({id:result.id,key:result.receiptToken,transparent}));}catch{}
}

function savedReceipt(){
  try{return JSON.parse(sessionStorage.getItem('delicias-pedido')||'null');}catch{return null;}
}

function showPaymentError(message){
  $('#payment-error').textContent=message;
  $('#payment-error').hidden=false;
}

function resetPaymentForm(){
  paymentVersion++;
  paymentBrick?.unmount();
  paymentBrick=undefined;
  $('#payment-fields').replaceChildren();
}

async function submitTransparentPayment(order,total,formData){
  if(paymentSubmitting)return;
  const {token,installments,payment_method_id,issuer_id,payer}=formData;
  const payment={token,installments,payment_method_id,issuer_id,payer:{identification:payer?.identification,address:payer?.address}};
  paymentSubmitting=true;
  $('#payment-back').disabled=true;
  $('#payment-error').hidden=true;
  try{
    const result=await api('/api/checkout/transparent',{method:'POST',body:JSON.stringify({...order,expectedTotal:total,payment})});
    saveReceipt(result,true);
    if(['rejected','cancelled'].includes(result.status))checkoutKey=crypto.randomUUID();
    $('#payment-dialog').close();
    await receipt(result.id,result.receiptToken);
  }catch(error){
    showPaymentError(error.message);
    throw error;
  }finally{
    paymentSubmitting=false;
    $('#payment-back').disabled=false;
  }
}

async function openTransparentPayment(order){
  const checkoutDialog=$('#checkout-dialog');
  const {total,paymentMethodIds}=await api('/api/checkout/transparent/quote',{method:'POST',body:JSON.stringify(order)});
  const MercadoPago=await loadPaymentSdk();
  if(!checkoutDialog.open||order.key!==checkoutKey)return;

  const option=paymentOptions[order.method];
  const dialog=$('#payment-dialog');
  const version=++paymentVersion;
  const active=()=>dialog.open&&version===paymentVersion;
  $('#payment-title').textContent=`Pagamento com ${option.label}`;
  $('#payment-total').textContent=money(total);
  $('#payment-loading').hidden=false;
  $('#payment-error').hidden=true;
  checkoutDialog.close();
  dialog.showModal();
  const failed=()=>{
    if(!active())return;
    $('#payment-loading').hidden=true;
    if($('#payment-error').hidden)showPaymentError('Não foi possível completar esta etapa. Confira os dados ou volte e tente novamente.');
  };
  try{
    const controller=await new MercadoPago(catalog.paymentPublicKey,{locale:'pt-BR'}).bricks().create('payment','payment-fields',{
      initialization:{amount:total/100,payer:{email:order.email}},
      customization:{paymentMethods:{[option.method]:paymentMethodIds,...(order.method==='debit'?{maxInstallments:1}:{})},
        visual:{defaultPaymentOption:{[option.form]:true}}},
      callbacks:{
        onReady:()=>{if(active())$('#payment-loading').hidden=true;},
        onError:failed,
        onSubmit:({formData})=>active()?submitTransparentPayment(order,total,formData):Promise.resolve(),
      },
    });
    if(active())paymentBrick=controller;
    else controller.unmount();
  }catch{failed();}
}

$('#payment-back').onclick=()=>{
  if(paymentSubmitting)return;
  $('#payment-dialog').close();
  $('#checkout-dialog').showModal();
};
$('#payment-dialog').addEventListener('cancel',event=>{event.preventDefault();$('#payment-back').click();});
$('#payment-dialog').addEventListener('close',resetPaymentForm);

$('#checkout-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target;
  const button=$('#pay-button');
  if(button.disabled||!form.reportValidity())return;
  button.disabled=true;
  button.textContent='Preparando seu pagamento…';
  const errorMessage=$('#checkout-error');
  errorMessage.hidden=true;
  try{
    const order={...Object.fromEntries(new FormData(form)),items:cart.map(item=>({...item})),key:checkoutKey};
    if(catalog.paymentPublicKey)await openTransparentPayment(order);
    else{
      const result=await api('/api/checkout',{method:'POST',body:JSON.stringify(order)});
      saveReceipt(result);
      location.assign(result.url);
    }
  }catch(error){
    errorMessage.textContent=error.message;
    errorMessage.hidden=false;
  }finally{
    button.disabled=false;
    button.innerHTML=`Ir para pagamento ${icon('arrow')}`;
  }
});
const statusLabels={creating:'Preparando pagamento',pending:'Aguardando pagamento',paid:'Pagamento confirmado ♡',rejected:'Pagamento não aprovado',cancelled:'Pagamento cancelado',refunded:'Pagamento reembolsado',charged_back:'Pagamento contestado',in_mediation:'Pagamento em análise'};

function resetPaymentStatus(){
  statusVersion++;
  statusBrick?.unmount();
  statusBrick=undefined;
}

async function showPaymentStatus(paymentId){
  const version=statusVersion;
  const container=$('#payment-status-fields');
  const active=()=>$('#receipt-dialog').open&&version===statusVersion;
  const failed=()=>{
    if(active())container.textContent='Não foi possível exibir as instruções de pagamento. Atualize o status para tentar novamente.';
  };
  try{
    const publicKey=catalog.paymentPublicKey||(await api('/api/catalog')).paymentPublicKey;
    if(!publicKey)return failed();
    const MercadoPago=await loadPaymentSdk();
    if(!active())return;
    container.replaceChildren();
    const controller=await new MercadoPago(publicKey,{locale:'pt-BR'}).bricks().create('statusScreen','payment-status-fields',{
      initialization:{paymentId},callbacks:{onReady:()=>{},onError:failed},
    });
    if(active())statusBrick=controller;
    else controller.unmount();
  }catch{failed();}
}

async function receipt(id,key){
  try{
    const {order:o}=await api(`/api/orders/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`);
    resetPaymentStatus();
    const message={paid:'Recebemos a confirmação do pagamento.',rejected:'O pagamento foi recusado. Volte à sacola para tentar novamente.',
      creating:'Estamos verificando o pagamento. Atualize o status antes de tentar pagar novamente.'}[o.status]||'O pagamento será confirmado pelo Mercado Pago.';
    $('#receipt-content').innerHTML=`${icon(o.status==='paid'?'heart':'shield')}<h2 id="receipt-title">${o.status==='paid'?'Seu carinho está a caminho!':'Acompanhe seu pedido'}</h2><span class="receipt-status">${esc(statusLabels[o.status]||o.status)}</span><p>Pedido ${esc(o.id.slice(0,8).toUpperCase())}<br>${message}</p>${o.items.map(i=>`<div class="summary-line"><span>${i.quantity} × ${esc(i.name)}</span><span>${money(i.price*i.quantity)}</span></div>`).join('')}<div class="summary-line total"><strong>Total</strong><strong>${money(o.total)}</strong></div>${o.paymentId?'<div id="payment-status-fields" role="status">Carregando instruções de pagamento…</div>':''}<button class="button secondary full" id="refresh-order">Atualizar status</button>${o.status==='pending'&&o.checkoutUrl?`<a class="button primary full" href="${esc(o.checkoutUrl)}">Retomar pagamento ${icon('arrow')}</a>`:''}`;
    $('#refresh-order').onclick=()=>receipt(id,key);
    if(!$('#receipt-dialog').open)$('#receipt-dialog').showModal();
    if(o.paymentId)await showPaymentStatus(o.paymentId);
    if(['paid','cancelled','rejected','refunded','charged_back'].includes(o.status)&&savedReceipt()?.id===id){
      try{sessionStorage.removeItem('delicias-pedido');}catch{}
    }
    if(o.status==='paid'){cart=[];saveCart();}
  }catch(error){toast(error.message);}
}
$('#receipt-dialog').addEventListener('close',resetPaymentStatus);
document.addEventListener('click',e=>{
  const close=e.target.closest('[data-close]');if(close){$('#'+close.dataset.close).close();return;}
  const addButton=e.target.closest('[data-add]');if(addButton){add(addButton.dataset.add);return;}
  const product=e.target.closest('[data-detail]');if(product){detail(product.dataset.detail);return;}
  const cat=e.target.closest('[data-category]');if(cat){category=cat.dataset.category;renderCategories();renderProducts();return;}
  const remove=e.target.closest('[data-remove]');if(remove){cart=cart.filter(i=>i.id!==remove.dataset.remove);saveCart();renderCart();return;}
  const qty=e.target.closest('[data-quantity]');if(qty){const item=cart.find(i=>i.id===qty.dataset.quantity);const p=catalog.products.find(p=>p.id===item.id);const value=item.quantity+Number(qty.dataset.delta);if(value<=0)cart=cart.filter(i=>i!==item);else if(value<=Math.min(p?.stock||0,99))item.quantity=value;saveCart();renderCart();return;}
  if(e.target.closest('#go-checkout'))checkout();
  if(e.target.closest('#reset-search')){$('#search').value='';category='Todos';renderCategories();renderProducts();}
});
$('#open-cart').addEventListener('click',async()=>{try{await loadCatalog();}catch(e){toast(e.message);}renderCart();$('#cart-dialog').showModal();});
$('#search').addEventListener('input',renderProducts);$('#sort').addEventListener('change',renderProducts);
$$('dialog:not(#payment-dialog)').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
window.addEventListener('storage',e=>{if(e.key==='delicias-cart-v1'){try{const next=JSON.parse(e.newValue||'[]');if(Array.isArray(next)){cart=next.filter(i=>typeof i.id==='string'&&Number.isInteger(i.quantity)&&i.quantity>0&&i.quantity<=99);updateCount();if($('#cart-dialog').open)renderCart();}}catch{}}});
images();updateCount();loadCatalog().catch(e=>{$('#products').innerHTML=`<div class="empty-state"><h3>Não conseguimos abrir o cardápio</h3><p>${esc(e.message)}</p><button class="button secondary" id="reload-catalog">Tentar novamente</button></div>`;$('#reload-catalog').onclick=()=>location.reload();});
const params=new URLSearchParams(location.search);
if(params.has('pedido')&&params.has('chave')){
  receipt(params.get('pedido'),params.get('chave'));
  history.replaceState(null,'','/');
}else{
  const saved=savedReceipt();
  if(saved?.transparent&&saved.id&&saved.key)receipt(saved.id,saved.key);
}
