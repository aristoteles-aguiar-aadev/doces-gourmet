export class ShopError extends Error { constructor(message,status=400) { super(message); this.status=status; } }
export const categories=['Brigadeiros','Bolos & fatias','Brownies','Doces no pote','Kits & presentes','Salgados','Bebidas'];
export function text(value,min,max,label) {
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max) throw new ShopError(`${label}: informe entre ${min} e ${max} caracteres.`);
  return value.trim();
}
export function validateProduct(p) {
  const name=text(p.name,2,100,'Nome'), description=text(p.description??'',0,1000,'Descrição');
  if(!categories.includes(p.category)) throw new ShopError('Categoria inválida.');
  if(!Number.isSafeInteger(p.price)||p.price<1||p.price>1000000) throw new ShopError('Preço inválido.');
  if(!Number.isSafeInteger(p.stock)||p.stock<0||p.stock>100000) throw new ShopError('Estoque inválido.');
  const image=text(p.image||'/marca.jpeg',1,1500,'Foto');
  if(!/^https:\/\//.test(image)&&!/^\/(?:uploads\/[a-f0-9-]+\.(?:jpg|png|webp)|marca\.jpeg)$/.test(image)) throw new ShopError('Use uma foto enviada ou um endereço HTTPS.');
  return {name,description,category:p.category,price:p.price,stock:p.stock,image,active:p.active===true,featured:p.featured===true,unit:text(p.unit||'unidade',1,40,'Unidade'),allergens:text(p.allergens||'',0,300,'Ingredientes e alergênicos')};
}
export function quote(state,input) {
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>50) throw new ShopError('Sua sacola está vazia ou tem itens demais.');
  if(!['pickup','delivery'].includes(input.fulfillment)) throw new ShopError('Escolha entrega ou retirada.');
  if(input.fulfillment==='delivery'&&!state.settings.deliveryEnabled) throw new ShopError('A entrega está indisponível. Escolha retirada.');
  const quantities=new Map();
  for(const i of input.items) {
    if(typeof i.id!=='string'||!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>99) throw new ShopError('Quantidade inválida.');
    quantities.set(i.id,(quantities.get(i.id)||0)+i.quantity);
  }
  const items=[...quantities].map(([id,quantity])=>{
    const p=state.products.find(p=>p.id===id&&p.active);
    if(!p) throw new ShopError('Um produto não está mais disponível.',409);
    if(quantity>p.stock||quantity>99) throw new ShopError(`Estoque insuficiente para ${p.name}.`,409);
    return {id,name:p.name,price:p.price,quantity};
  });
  const subtotal=items.reduce((sum,i)=>sum+i.price*i.quantity,0);
  const deliveryFee=input.fulfillment==='delivery'?state.settings.deliveryFee:0;
  return {items,subtotal,deliveryFee,total:subtotal+deliveryFee};
}
export function customerInput(input) {
  const name=text(input.name,3,100,'Nome'),email=text(input.email,5,150,'E-mail');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ShopError('Informe um e-mail válido.');
  const phone=String(input.phone||'').replace(/\D/g,'');
  if(!/^\d{10,11}$/.test(phone)) throw new ShopError('Informe o telefone com DDD.');
  return {name,email,phone,address:input.fulfillment==='delivery'?text(input.address,10,400,'Endereço completo'):'',notes:text(input.notes||'',0,400,'Observações')};
}
