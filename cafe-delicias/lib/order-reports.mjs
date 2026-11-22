import {ShopError} from './shop.mjs';

const timeZone='America/Fortaleza';
const dateTime=new Intl.DateTimeFormat('pt-BR',{timeZone,dateStyle:'short',timeStyle:'short'});
const calendarDay=new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
const currency=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const money=cents=>currency.format(cents/100);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
})[char]);
const statuses={
  creating:'Preparando checkout',pending:'Aguardando pagamento',paid:'Pago',rejected:'Não aprovado',
  cancelled:'Cancelado',refunded:'Reembolsado',charged_back:'Contestado',in_mediation:'Em análise',
};
const methods={pix:'Pix',boleto:'Boleto',credit:'Crédito',debit:'Débito'};

function printablePage(title, layout, content, options='') {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} · Dois Amores Doceria</title>
  <link rel="stylesheet" href="/order-print.css">
  <script src="/order-print.js" defer></script>
</head>
<body class="${layout}">
  <nav class="print-toolbar" aria-label="Opções de impressão">
    ${options}
    <button id="print-document" type="button">Imprimir ou salvar em PDF</button>
  </nav>
  <main class="print-document">${content}</main>
</body>
</html>`;
}

function orderDetails(order) {
  const status=statuses[order.status]||order.status;
  const method=methods[order.method];
  return `<p>${escapeHtml(dateTime.format(new Date(order.createdAt)))} · ${escapeHtml(order.customer?.name)}</p>
    <p>${order.fulfillment==='delivery'?'Entrega':'Retirada'}${method?` · ${method}`:''} · <strong>${escapeHtml(status)}</strong></p>`;
}

function totals(order) {
  return `<dl class="totals">
    <div><dt>Subtotal</dt><dd>${money(order.subtotal)}</dd></div>
    <div><dt>Frete</dt><dd>${money(order.deliveryFee)}</dd></div>
    <div class="grand-total"><dt>Total do pedido</dt><dd>${money(order.total)}</dd></div>
  </dl>`;
}

function itemDescription(item) {
  return `<strong>${escapeHtml(item.name)}</strong>${item.description?`<small>${escapeHtml(item.description)}</small>`:''}`;
}

function dateFilter(value) {
  if(!value)return '';
  const date=Date.parse(value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date)||new Date(date).toISOString().slice(0,10)!==value){
    throw new ShopError('Informe datas válidas para o relatório.');
  }
  return value;
}

export function orderReport(orders, query) {
  const from=dateFilter(query.get('from')),to=dateFilter(query.get('to'));
  if(from&&to&&from>to)throw new ShopError('A data inicial deve ser anterior ou igual à data final.');
  const included=orders.filter(order=>{
    const day=calendarDay.format(new Date(order.createdAt));
    return (!from||day>=from)&&(!to||day<=to);
  });
  const paid=included.filter(order=>order.status==='paid');
  const displayDate=value=>value.split('-').reverse().join('/');
  const period=from&&to?`${displayDate(from)} a ${displayDate(to)}`
    :from?`A partir de ${displayDate(from)}`:to?`Até ${displayDate(to)}`:'Todo o período';
  const sections=included.map(order=>`
    <section class="report-order">
      <header>
        <h2>Pedido ${escapeHtml(order.id.slice(0,8).toUpperCase())}</h2>
        ${orderDetails(order)}
      </header>
      <table>
        <thead><tr><th scope="col">Descrição</th><th scope="col" class="number">Qtd.</th>
          <th scope="col" class="number">Valor unitário</th><th scope="col" class="number">Total do item</th></tr></thead>
        <tbody>${order.items.map(item=>`<tr><td>${itemDescription(item)}</td>
          <td class="number">${escapeHtml(item.quantity)}</td><td class="number">${money(item.price)}</td>
          <td class="number">${money(item.quantity*item.price)}</td></tr>`).join('')}</tbody>
      </table>
      ${totals(order)}
    </section>`).join('');
  return printablePage('Relatório de pedidos','a4',`
    <header class="document-heading">
      <p>Dois Amores Doceria</p>
      <h1>Relatório de pedidos</h1>
      <p>${period}</p>
    </header>
    <dl class="report-summary">
      <div><dt>Pedidos no período</dt><dd>${included.length}</dd></div>
      <div><dt>Pedidos pagos</dt><dd>${paid.length}</dd></div>
      <div><dt>Total confirmado</dt><dd>${money(paid.reduce((sum,order)=>sum+order.total,0))}</dd></div>
    </dl>
    ${sections||'<p>Nenhum pedido encontrado no período.</p>'}`);
}

export function orderReceipt(order, paper) {
  const width=paper||'80';
  if(!['58','80'].includes(width))throw new ShopError('Escolha papel térmico de 58 ou 80 mm.');
  const id=escapeHtml(order.id.slice(0,8).toUpperCase());
  const sizeOptions=`<span>Papel térmico: <a href="?paper=58"${width==='58'?' aria-current="page"':''}>58 mm</a>
    <a href="?paper=80"${width==='80'?' aria-current="page"':''}>80 mm</a></span>
    <span>Selecione a mesma largura na janela da impressora.</span>`;
  return printablePage(`Via do cliente · Pedido ${id}`,`thermal thermal-${width}`,`
    <header class="document-heading">
      <h1>Dois Amores Doceria</h1>
      <p>Via do cliente</p>
      <p><strong>Pedido ${id}</strong></p>
      ${orderDetails(order)}
    </header>
    <ul class="receipt-items" aria-label="Itens do pedido">${order.items.map(item=>`
      <li>${itemDescription(item)}<p>${escapeHtml(item.quantity)} × ${money(item.price)}
        <strong>${money(item.quantity*item.price)}</strong></p></li>`).join('')}</ul>
    ${totals(order)}
    <p class="receipt-footer">Obrigado pelo pedido!</p>`,sizeOptions);
}
