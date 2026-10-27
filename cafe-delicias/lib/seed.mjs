const image=(id)=>`https://images.unsplash.com/${id}?auto=format&fit=crop&w=850&q=85`;
export const initialState=()=>({
  version:1,admin:null,orders:[],
  settings:{storeName:'Café & Delícias',tagline:'Mãe e Filha',deliveryEnabled:false,deliveryFee:800,deliveryArea:'',pickupAddress:'',hours:'',whatsapp:'',catalogExample:true},
  products:[
    {id:'brigadeiro',name:'Brigadeiro belga',description:'Chocolate intenso, textura cremosa e um carinho em cada bolinha.',category:'Brigadeiros',price:450,stock:30,unit:'unidade',image:image('photo-1511381939415-e440154668e4'),active:true,featured:true,allergens:'Contém leite. Pode conter soja e castanhas.'},
    {id:'bolo-morango',name:'Bolo de morango',description:'Massa fofinha, creme delicado e morangos frescos. Uma fatia de felicidade.',category:'Bolos & fatias',price:1890,stock:12,unit:'fatia',image:image('photo-1464305795204-6f5bbfc7fb81'),active:true,featured:true,allergens:'Contém glúten, ovos e leite.'},
    {id:'brownie',name:'Brownie da casa',description:'Casquinha delicada por fora, chocolate bem molhadinho por dentro.',category:'Brownies',price:1290,stock:18,unit:'unidade',image:image('photo-1606313564200-e75d5e30476c'),active:true,featured:true,allergens:'Contém glúten, ovos, leite e soja.'},
    {id:'pote',name:'Doce de leite no pote',description:'Camadas generosas de bolo e doce de leite para saborear de colher.',category:'Doces no pote',price:1690,stock:15,unit:'pote · 220 ml',image:image('photo-1488477181946-6428a0291777'),active:true,featured:false,allergens:'Contém glúten, ovos e leite.'},
    {id:'cupcake',name:'Cupcake de baunilha',description:'Um bolinho macio com cobertura cremosa e um toque de encanto.',category:'Bolos & fatias',price:990,stock:16,unit:'unidade',image:image('photo-1576618148400-f54bed99fcfd'),active:true,featured:false,allergens:'Contém glúten, ovos e leite.'},
    {id:'presente',name:'Caixinha de carinho',description:'Uma seleção especial de doces para presentear quem adoça sua vida.',category:'Kits & presentes',price:3990,stock:6,unit:'caixa · 6 doces',image:image('photo-1481391319762-47dff72954d9'),active:true,featured:true,allergens:'Contém leite, glúten, ovos e soja. Pode conter castanhas.'}
  ].map(p=>({...p,updatedAt:new Date().toISOString()}))
});
