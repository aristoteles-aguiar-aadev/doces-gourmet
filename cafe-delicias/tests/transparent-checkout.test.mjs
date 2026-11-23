import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FileStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';

test('Checkout Transparente processa cartão, Pix e boleto, com valor da loja e confirmação assinada', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'delicias-card-'));
  const store = new FileStore(directory);
  await store.init();
  await store.update(state => {
    state.settings.catalogExample = false;
    state.settings.pickupAddress = 'Rua Exemplo, 123';
    state.products = [{id: 'doce', name: 'Doce', price: 950, stock: 3, active: true}];
  });

  const origin = 'https://loja.example';
  const paymentCalls = [];
  let payment, providerStatus = 'pending';
  const app = await createApp({
    store, baseUrl: origin, quiet: true, adminPassword: 'senha-forte-de-teste',
    accessToken: 'hosted-token', webhookSecret: 'hosted-secret',
    transparentPublicKey: 'checkout-public-key', transparentAccessToken: 'merchant-token', transparentWebhookSecret: 'checkout-secret',
    paymentFetch: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer merchant-token');
      if (url.endsWith('/v1/payment_methods')) return Response.json([
        {id: 'visa', payment_type_id: 'credit_card', status: 'active', min_allowed_amount: 1},
        {id: 'debcaixa', payment_type_id: 'debit_card', status: 'active', min_allowed_amount: 1},
        {id: 'pix', payment_type_id: 'bank_transfer', status: 'active', min_allowed_amount: 1},
        {id: 'bolbradesco', payment_type_id: 'ticket', status: 'active', min_allowed_amount: 5},
      ]);
      if (url.endsWith('/v1/payments') && init.method === 'POST') {
        const sent = JSON.parse(init.body);
        paymentCalls.push({sent, idempotency: init.headers['X-Idempotency-Key']});
        if (providerStatus === 'timeout') throw new Error('Falha de conexão simulada');
        const type = {visa: 'credit_card', debcaixa: 'debit_card', pix: 'bank_transfer', bolbradesco: 'ticket'}[sent.payment_method_id];
        payment = {id: 122 + paymentCalls.length, external_reference: sent.external_reference, status: providerStatus,
          currency_id: 'BRL', transaction_amount: sent.transaction_amount,
          payment_type_id: type,
          installments: sent.installments};
        return Response.json(payment, {status: 201});
      }
      if (url.endsWith('/v1/payments/123')) return Response.json({...payment, status: providerStatus});
      throw new Error('Requisição inesperada ao Mercado Pago');
    },
  });
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, payload, requestOrigin = origin) => fetch(base + path, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Shop-Request': '1', Origin: requestOrigin},
    body: JSON.stringify(payload),
  });
  const details = {items: [{id: 'doce', quantity: 1, price: 1}], fulfillment: 'pickup', method: 'credit',
    name: 'Maria Silva', email: 'maria@example.com', phone: '85999999999', consent: 'on', key: randomUUID()};
  const card = {token: 'token-de-cartao-teste', installments: 2, payment_method_id: 'visa', issuer_id: '1',
    payer: {identification: {type: 'CPF', number: '12345678901'}}, transaction_amount: 1};

  const catalog = await (await fetch(base + '/api/catalog')).json();
  assert.equal(catalog.paymentPublicKey, 'checkout-public-key');
  assert.doesNotMatch(JSON.stringify(catalog), /merchant-token|checkout-secret/);
  const quotePath = '/api/checkout/transparent/quote';
  const checkoutPath = '/api/checkout/transparent';
  assert.equal((await post(quotePath, details, 'https://outro.example')).status, 403);
  assert.deepEqual(await (await post(quotePath, details)).json(), {total: 950, paymentMethodIds: ['visa']});
  assert.equal((await store.read()).products[0].stock, 3);

  assert.equal((await post(checkoutPath, {...details, expectedTotal: 100, payment: card})).status, 409);
  assert.equal((await post(checkoutPath, {...details, expectedTotal: 950, payment: {...card, payment_method_id: 'debcaixa'}})).status, 400);
  assert.equal(paymentCalls.length, 0);

  const body = {...details, expectedTotal: 950, payment: card};
  const [one, two] = await Promise.all([post(checkoutPath, body), post(checkoutPath, body)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const result = await one.json();
  assert.equal(result.id, (await two.json()).id);
  assert.equal(paymentCalls.length, 1);
  assert.equal(paymentCalls[0].sent.transaction_amount, 9.5);
  assert.equal(paymentCalls[0].sent.external_reference, result.id);
  assert.equal(paymentCalls[0].idempotency, result.id);
  assert.equal(new URL(paymentCalls[0].sent.notification_url).pathname, '/api/payments/transparent-webhook');
  let state = await store.read();
  assert.equal(state.products[0].stock, 2);
  assert.doesNotMatch(JSON.stringify(state), /token-de-cartao-teste|12345678901/);

  const notify = secret => {
    const ts = String(Date.now());
    const digest = createHmac('sha256', secret).update(`id:123;request-id:card-request;ts:${ts};`).digest('hex');
    return fetch(base + '/api/payments/transparent-webhook?data.id=123', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-request-id': 'card-request', 'x-signature': `ts=${ts},v1=${digest}`},
      body: JSON.stringify({type: 'payment', data: {id: 123}}),
    });
  };
  providerStatus = 'approved';
  assert.equal((await notify('hosted-secret')).status, 401);
  assert.equal((await notify('checkout-secret')).status, 200);
  const receipt = await (await fetch(`${base}/api/orders/${result.id}?key=${result.receiptToken}`)).json();
  assert.equal(receipt.order.status, 'paid');
  state = await store.read();
  assert.equal(state.orders[0].paymentType, 'credit_card');
  assert.equal(state.orders[0].installments, 2);

  providerStatus = 'rejected';
  const debit = {...details, method: 'debit', key: randomUUID(), expectedTotal: 950,
    payment: {...card, payment_method_id: 'debcaixa', installments: 1}};
  const declined = await post(checkoutPath, debit);
  assert.equal(declined.status, 200);
  assert.equal((await declined.json()).status, 'rejected');
  assert.equal((await store.read()).products[0].stock, 2);
  assert.equal((await (await post(checkoutPath, debit)).json()).status, 'rejected');
  assert.equal(paymentCalls.length, 2);

  providerStatus = 'pending';
  const pix = {...details, method: 'pix', key: randomUUID(), expectedTotal: 950,
    payment: {payment_method_id: 'pix', payer: card.payer}};
  const pixPayment = await (await post(checkoutPath, pix)).json();
  assert.equal(pixPayment.status, 'pending');
  const pixReceipt = await (await fetch(`${base}/api/orders/${pixPayment.id}?key=${pixPayment.receiptToken}`)).json();
  assert.equal(pixReceipt.order.paymentId, '125');
  assert.equal(pixReceipt.order.checkoutUrl, null);
  assert.equal(paymentCalls[2].sent.token, undefined);
  assert.equal(paymentCalls[2].sent.payment_method_id, 'pix');

  const address = {zip_code: '60123-456', street_name: 'Rua Exemplo', street_number: 'S/N',
    neighborhood: 'Centro', city: 'Fortaleza', federal_unit: 'CE'};
  const boleto = {...details, method: 'boleto', key: randomUUID(), expectedTotal: 950,
    payment: {payment_method_id: 'bolbradesco', payer: {...card.payer, address}}};
  const ticket = await (await post(checkoutPath, boleto)).json();
  assert.equal(ticket.status, 'pending');
  assert.equal(paymentCalls[3].sent.payer.address.zip_code, '60123456');
  const ticketReceipt = await (await fetch(`${base}/api/orders/${ticket.id}?key=${ticket.receiptToken}`)).json();
  assert.equal(ticketReceipt.order.paymentId, '126');
  assert.doesNotMatch(JSON.stringify(await store.read()), /60123456|12345678901/);

  await store.update(state => { state.products[0].stock = 1; });
  providerStatus = 'timeout';
  const retry = {...body, key: randomUUID()};
  const firstAttempt = await (await post(checkoutPath, retry)).json();
  assert.equal(firstAttempt.status, 'creating');
  const secondAttempt = await (await post(checkoutPath, retry)).json();
  assert.equal(secondAttempt.id, firstAttempt.id);
  assert.equal(paymentCalls.length, 5);
  assert.equal((await store.read()).products[0].stock, 0);
});
