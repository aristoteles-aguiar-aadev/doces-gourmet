import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FileStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';

test('registra a recusa do Mercado Pago no checkout sem expor dados ao cliente', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'delicias-checkout-log-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const store = new FileStore(directory);
  await store.init();
  await store.update(state => {
    state.settings.catalogExample = false;
    state.settings.pickupAddress = 'Rua Exemplo, 123';
    state.products = [{id: 'doce', name: 'Doce de teste', price: 450, stock: 1, active: true}];
  });

  const warning = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const app = await createApp({
    store,
    adminPassword: 'senha-forte-de-teste',
    accessToken: 'token-test',
    webhookSecret: 'secret-test',
    baseUrl: 'https://loja.example',
    paymentFetch: async () => Response.json({
      error: 'invalid_items',
      code: 'cliente@example.com',
      message: 'Detalhes do cliente e da requisição',
      status: 400,
    }, {status: 400}),
  });
  t.after(() => new Promise(resolve => app.close(resolve)));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));

  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/checkout`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shop-Request': '1', Origin: 'https://loja.example'},
    body: JSON.stringify({items: [{id: 'doce', quantity: 1}], fulfillment: 'pickup', method: 'pix',
      name: 'Maria Silva', email: 'cliente@example.com', phone: '85999999999', consent: 'on', key: 'a'.repeat(32)}),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {error: 'Não foi possível acessar o pagamento. Tente novamente em instantes.'});
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(warning.mock.calls[0].arguments[1], {status: 400, codes: ['invalid_items']});
});
