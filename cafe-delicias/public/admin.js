const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],money=n=>(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let products=[],categories=[],settings={},paymentsReady=false,timer;
const statuses={creating:'Preparando checkout',pending:'Aguardando pagamento',paid:'Pago',rejected:'Não aprovado',cancelled:'Cancelado',refunded:'Reembolsado',charged_back:'Contestado',in_mediation:'Em análise'};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>$('#toast').hidden=true,4000);}
function error(id,e){$(id).textContent=e.message;$(id).hidden=false;}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Shop-Request':'1',...options.headers}});const data=await response.json();if(!response.ok){if(response.status===401&&path!=='/api/login')loginView();throw new Error(data.error||'Não foi possível salvar.');}return data;}
function loginView(){$('#login-panel').hidden=false;$('#dashboard').hidden=true;$('#logout').hidden=true;}
async function dashboard(){const [catalog,config]=await Promise.all([api('/api/admin/products'),api('/api/admin/settings')]);products=catalog.products;categories=catalog.categories;settings=config.settings;paymentsReady=config.paymentsReady;$('#login-panel').hidden=true;$('#dashboard').hidden=false;$('#logout').hidden=false;renderProducts();renderSettings();}
function renderProducts(){
  $('#products-count').textContent=`${products.length} ${products.length===1?'delícia cadastrada':'delícias cadastradas'} · ${products.filter(p=>p.active).length} no cardápio`;
  $('#admin-notice').hidden=!settings.catalogExample&&paymentsReady;
  $('#admin-notice').textContent=settings.catalogExample?'Seu catálogo está em demonstração, com produtos e fotos ilustrativos. Cadastre seus produtos reais e revise “Minha loja” para liberar os pedidos.':!paymentsReady?'Os produtos estão salvos. A configuração do Mercado Pago ainda precisa ser concluída para receber pagamentos.':'';
  $('#admin-products').innerHTML=products.length?products.map(p=>`<article class="admin-product"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"><div class="admin-product-info"><h3>${esc(p.name)}</h3><span class="status-label ${p.active?'':'paused'}">${p.active?'Visível na loja':'Pausado'}</span><div class="product-meta"><strong>${money(p.price)}</strong><span>${p.stock} em estoque</span></div><button class="button secondary full" data-edit="${esc(p.id)}">Editar produto ↗</button></div></article>`).join(''):'<div class="empty-state"><h3>O primeiro docinho começa aqui</h3><p>Cadastre um produto para montar seu cardápio.</p></div>';
  $$('#admin-products img').forEach(img=>img.onerror=()=>{img.onerror=null;img.src='/marca.jpeg';});
}
function renderSettings(){const form=$('#settings-form');for(const [key,value] of Object.entries(settings)){const field=form.elements[key];if(!field)continue;if(field.type==='checkbox')field.checked=value;else field.value=key==='deliveryFee'?(value/100).toFixed(2):value;}$('#gateway-status').textContent=paymentsReady?'As variáveis de pagamento estão configuradas. Antes de vender, valide uma compra de teste e o recebimento das notificações no seu ambiente.':'Pagamentos ainda não ativados. Os três valores do provedor devem ser configurados no servidor para habilitar as cobranças.';}
function editProduct(id){const p=products.find(p=>p.id===id),form=$('#product-form');form.reset();form.elements.category.innerHTML=categories.map(c=>`<option>${esc(c)}</option>`).join('');form.elements.id.value=p?.id||'';form.elements.image.value=p?.image||'/marca.jpeg';if(p)for(const [key,value] of Object.entries(p)){const f=form.elements[key];if(!f)continue;if(f.type==='checkbox')f.checked=value;else f.value=key==='price'?(value/100).toFixed(2):value;}$('#photo-preview').src=p?.image||'/marca.jpeg';$('#editor-title').textContent=p?'Editar uma delícia':'Uma nova delícia';$('#delete-product').hidden=!p;$('#product-error').hidden=true;$('#photo-file').value='';$('#editor').showModal();}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;$('#login-error').hidden=true;try{await api('/api/login',{method:'POST',body:JSON.stringify({username:e.target.elements.username.value,password:e.target.elements.password.value})});e.target.reset();await dashboard();}catch(e){error('#login-error',e);}finally{button.disabled=false;}});
$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});loginView();}catch(e){toast(e.message);}};
$('#new-product').onclick=()=>editProduct();
$('#photo-file').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  if(file.size>3000000||!['image/jpeg','image/png','image/webp'].includes(file.type)){e.target.value='';return error('#product-error',new Error('Envie JPG, PNG ou WebP com até 3 MB.'));}
  $('#save-product').disabled=true;$('#product-error').hidden=true;
  try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});const result=await api('/api/admin/upload',{method:'POST',body:JSON.stringify({data})});$('#product-form').elements.image.value=result.url;$('#photo-preview').src=result.url;toast('Foto enviada. Salve o produto para publicar.');}catch(e){error('#product-error',e);}finally{$('#save-product').disabled=false;}
});
$('#product-form').elements.image.addEventListener('change',e=>{if(e.target.value.startsWith('https://')||e.target.value.startsWith('/uploads/')||e.target.value==='/marca.jpeg')$('#photo-preview').src=e.target.value;});
$('#product-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;if(!f.reportValidity())return;$('#save-product').disabled=true;$('#product-error').hidden=true;try{const b=Object.fromEntries(new FormData(f));b.price=Math.round(Number(b.price)*100);b.stock=Number(b.stock);b.active=f.elements.active.checked;b.featured=f.elements.featured.checked;const id=b.id;delete b.id;await api(id?`/api/admin/products/${id}`:'/api/admin/products',{method:id?'PUT':'POST',body:JSON.stringify(b)});$('#editor').close();await dashboard();toast('Produto salvo com carinho. Já está no seu catálogo!');}catch(e){error('#product-error',e);}finally{$('#save-product').disabled=false;}});
$('#delete-product').onclick=()=>$('#confirm-delete').showModal();
$('#confirm-delete-button').onclick=async()=>{const button=$('#confirm-delete-button');button.disabled=true;try{await api(`/api/admin/products/${$('#product-form').elements.id.value}`,{method:'DELETE'});$('#confirm-delete').close();$('#editor').close();await dashboard();toast('Produto excluído.');}catch(e){toast(e.message);}finally{button.disabled=false;}};
$('#settings-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,button=f.querySelector('button[type=submit]');button.disabled=true;$('#settings-error').hidden=true;try{const b=Object.fromEntries(new FormData(f));b.deliveryFee=Math.round(Number(b.deliveryFee)*100);b.deliveryEnabled=f.elements.deliveryEnabled.checked;b.catalogExample=f.elements.catalogExample.checked;await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(b)});await dashboard();toast('Informações da loja salvas.');}catch(e){error('#settings-error',e);}finally{button.disabled=false;}});
function orderCard(order){
  const code=esc(order.id.slice(0,8).toUpperCase());
  const method=({pix:'PIX',boleto:'Boleto',credit:'Crédito',debit:'Débito'})[order.method];
  const rows=order.items.map(item=>`<tr>
    <td><strong>${esc(item.name)}</strong>${item.description?`<small>${esc(item.description)}</small>`:''}</td>
    <td>${esc(item.quantity)}</td><td>${money(item.price)}</td><td>${money(item.price*item.quantity)}</td>
  </tr>`).join('');
  return `<article class="order-card">
    <div class="order-card-header">
      <h3>Pedido ${code}</h3>
      <span class="status-label ${order.status==='paid'?'':'paused'}">${esc(statuses[order.status]||order.status)}</span>
    </div>
    <p>${esc(new Date(order.createdAt).toLocaleString('pt-BR'))} · ${esc(order.customer.name)} · ${esc(order.customer.phone)}<br>${esc(order.customer.email)}</p>
    <div class="order-items">
      <table aria-label="Itens do pedido ${code}">
        <thead><tr><th scope="col">Descrição</th><th scope="col">Qtd.</th><th scope="col">Valor unit.</th><th scope="col">Total do item</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p>Subtotal ${money(order.subtotal)} · Frete ${money(order.deliveryFee)} · <strong>Total ${money(order.total)}</strong></p>
    <p>${esc(method)} · ${order.fulfillment==='delivery'?'Entrega':'Retirada'}
      ${order.customer.address?`<br>${esc(order.customer.address)}`:''}
      ${order.customer.notes?`<br>Observações: ${esc(order.customer.notes)}`:''}</p>
    <div class="order-actions">
      <a class="button secondary" href="/api/admin/orders/${encodeURIComponent(order.id)}/receipt" target="_blank" rel="noopener" aria-label="Abrir via térmica do pedido ${code}">Via térmica ↗</a>
      <button class="button secondary" data-sync="${esc(order.id)}">Consultar pagamento</button>
    </div>
  </article>`;
}
async function orders(){
  const {orders}=await api('/api/admin/orders');
  const paid=orders.filter(order=>order.status==='paid');
  $('#order-stats').innerHTML=`<div class="stat"><span>Pedidos recebidos</span><strong>${orders.length}</strong></div>
    <div class="stat"><span>Pagamentos confirmados</span><strong>${paid.length}</strong></div>
    <div class="stat"><span>Total confirmado</span><strong>${money(paid.reduce((sum,order)=>sum+order.total,0))}</strong></div>`;
  $('#admin-orders').innerHTML=orders.length?orders.map(orderCard).join(''):'<div class="empty-state"><h3>Nenhum pedido recebido</h3><p>Os pedidos aparecerão aqui.</p></div>';
}
$('#refresh-orders').onclick=()=>orders().catch(e=>toast(e.message));
document.addEventListener('click',async e=>{
  const close=e.target.closest('[data-close]');if(close){$('#'+close.dataset.close).close();return;}
  const edit=e.target.closest('[data-edit]');if(edit){editProduct(edit.dataset.edit);return;}
  const tab=e.target.closest('[data-tab]');if(tab){$$('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b===tab)));['products','orders','settings'].forEach(name=>$('#tab-'+name).hidden=name!==tab.dataset.tab);if(tab.dataset.tab==='orders')orders().catch(e=>toast(e.message));return;}
  const sync=e.target.closest('[data-sync]');if(sync){sync.disabled=true;try{await api(`/api/admin/orders/${sync.dataset.sync}/sync`,{method:'POST',body:'{}'});await orders();toast('Status consultado no Mercado Pago.');}catch(e){toast(e.message);sync.disabled=false;}}
});
$('#photo-preview').onerror=()=>{$('#photo-preview').src='/marca.jpeg';};
api('/api/session').then(s=>{
  const firstAccessNote=$('#first-access-note');
  if(s.hosted&&firstAccessNote)firstAccessNote.textContent='Primeiro acesso? Consulte o arquivo system/acesso-admin.txt no armazenamento privado da sua conta Vercel, ou use a senha definida nas configurações da hospedagem.';
  if(s.authenticated)return dashboard();
}).catch(e=>error('#login-error',e));
