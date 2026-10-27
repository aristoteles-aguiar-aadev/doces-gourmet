import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('checkout usa preço do catálogo e soma quantidades repetidas', async () => {
  const { quote } = await import('../lib/shop.mjs');
  const state = { products: [{ id:'a', name:'Brownie', price:1250, stock:5, active:true }], settings:{deliveryFee:800,deliveryEnabled:true} };
  const result = quote(state, {items:[{id:'a',quantity:1,price:1},{id:'a',quantity:2}],fulfillment:'delivery'});
  assert.equal(result.total,4550); assert.equal(result.items[0].quantity,3);
});
test('checkout rejeita estoque insuficiente, frações e produto pausado', async () => {
  const { quote } = await import('../lib/shop.mjs');
  const state = { products: [{id:'a',name:'Doce',price:500,stock:2,active:true}], settings:{deliveryEnabled:false} };
  for (const quantity of [0,-1,1.5,3]) assert.throws(()=>quote(state,{items:[{id:'a',quantity}],fulfillment:'pickup'}));
  state.products[0].active=false;
  assert.throws(()=>quote(state,{items:[{id:'a',quantity:1}],fulfillment:'pickup'}));
});
test('cadastro valida preço, estoque e endereços de imagem', async () => {
  const { validateProduct } = await import('../lib/shop.mjs');
  const product={name:'Brigadeiro',description:'Chocolate',category:'Brigadeiros',price:450,stock:10,image:'/marca.jpeg',active:true};
  assert.equal(validateProduct(product).price,450);
  for(const change of [{price:0},{price:1.2},{stock:-1},{image:'javascript:alert(1)'},{name:''}]) assert.throws(()=>validateProduct({...product,...change}));
});
test('banco salva cadastros após reabrir e serializa escritas concorrentes', async () => {
  const { FileStore } = await import('../lib/store.mjs');
  const directory=await mkdtemp(join(tmpdir(),'delicias-test-'));
  try {
    const store=new FileStore(directory); await store.init();
    await Promise.all(Array.from({length:12},()=>store.update(s=>{ s.settings.counter=(s.settings.counter||0)+1; })));
    const reopened=new FileStore(directory); await reopened.init();
    assert.equal((await reopened.read()).settings.counter,12);
  } finally {await rm(directory,{recursive:true,force:true});}
});
