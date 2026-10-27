# Café & Delícias — Mãe e Filha

Loja responsiva com catálogo, pesquisa, categorias, ordenação, detalhes dos produtos, alergênicos, sacola persistente, checkout e painel administrativo. Feita com HTML, CSS, JavaScript e Node.js. A execução local usa o Node nativo; a Vercel usa `@vercel/blob` para persistência privada.

**Publicação na Vercel:** veja [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md) para armazenamento, primeiro acesso e variáveis de produção. As instruções de disco abaixo se aplicam ao servidor local.

## Rodar

```powershell
node server.mjs
```

Abra http://127.0.0.1:3180 e http://127.0.0.1:3180/admin. A senha inicial é gerada em `data/acesso-admin.txt`. Para escolher outra senha, configure `ADMIN_PASSWORD` no `.env` e reinicie. Não versionar o `.env` nem a pasta `data`.

O servidor abre apenas no próprio computador por padrão. O arquivo `.env.example` documenta as configurações; copie-o para `.env` antes de editar. Reinicie após alterações de ambiente. Se a porta estiver ocupada, altere `PORT`.

## Cadastrar as delícias de cada dia

1. Entre no painel e clique em **Cadastrar uma delícia**.
2. Envie uma foto JPG, PNG ou WebP de até 3 MB, ou informe uma URL HTTPS.
3. Preencha nome, categoria, descrição, preço, unidade, quantidade disponível e alergênicos reais.
4. Salve. O produto aparece na loja quando **Visível na loja** está marcado. Estoque zero mostra o produto como esgotado.
5. Para o dia seguinte, edite o estoque e pause os produtos que não serão produzidos.

Em **Minha loja**, configure o endereço de retirada, horários, WhatsApp e a entrega. A entrega usa taxa fixa e a região informada no painel; não há cálculo de frete ou validação automática de CEP. Ela começa desativada até que os bairros atendidos sejam definidos.

O catálogo inicial tem seis exemplos, com preços, fotos e alergênicos ilustrativos. Substitua-os pelos produtos reais. A história apresentada é um texto editorial sugerido a partir da marca e pode ser editada em `public/index.html`.

## Onde ficam salvos os dados

Produtos, configurações e pedidos ficam no arquivo **`data/loja.json` no servidor**, com escrita serializada e substituição atômica. Fotos enviadas ficam em `data/uploads`. O navegador guarda apenas a sacola. Os cadastros permanecem após fechar o navegador ou reiniciar o servidor.

Esta edição usa um arquivo JSON persistente, não um banco relacional. É adequada para uma instância pequena; execute **um único processo**, com volume persistente. Há uma trava `data/.server.lock` para impedir dois servidores sobre o mesmo arquivo. Se o processo for encerrado à força, confirme que não está mais rodando antes de remover essa trava. Para escalar para múltiplas instâncias, migre o armazenamento para PostgreSQL/SQLite com transações.

O painel oferece um backup JSON sem o hash de acesso. Para recuperação completa, mantenha uma cópia privada de toda a pasta `data`, incluindo fotos. Faça o backup com o servidor parado. Não publique essa pasta em um servidor estático. Não existe importação automática de backup pelo painel.

## Ativar pagamentos

O checkout está integrado à API de preferências do **Mercado Pago Checkout Pro**. O cliente escolhe PIX, boleto, crédito ou débito e conclui a operação no ambiente do provedor. A disponibilidade final depende dos meios habilitados na conta, do cartão e das regras do Mercado Pago; débito não equivale a aceitação universal de todos os cartões.

1. Configure uma aplicação e obtenha as credenciais na sua conta Mercado Pago. Use primeiro credenciais e compradores de teste.
2. Publique o servidor em um endereço HTTPS e defina `PUBLIC_BASE_URL` com a origem exata, **sem barra no final**.
3. Configure `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` no ambiente privado do servidor.
4. Configure o webhook de pagamentos para `https://seu-dominio/api/payments/webhook` e use a mesma chave secreta.
5. Revise os produtos, o endereço e os dados comerciais; desative **Manter catálogo em demonstração** no painel.
6. Valide o fluxo completo no ambiente de testes antes de usar credenciais de produção: PIX, boleto, crédito, débito disponível, rejeição, notificação duplicada e reembolso.

Sem as três configurações, ou com o catálogo em demonstração, o sistema **bloqueia cobranças**. Não gera PIX ou boleto fictícios, nem recebe dados de cartão na loja. A integração externa não foi homologada nesta sessão, pois não foram fornecidas credenciais e a rede do ambiente bloqueou conexões externas.

O servidor recalcula preços e frete, valida estoque e reserva os itens ao iniciar o pedido. Reenvios simultâneos do mesmo checkout compartilham a mesma preferência durante o processo. A confirmação exige webhook com assinatura válida e consulta autenticada ao provedor, com conferência de valor e moeda. Uma URL de retorno nunca confirma o pagamento. Também é possível consultar o pagamento pelo painel.

Pedidos abandonados ou com tentativa rejeitada **mantêm o estoque reservado** para evitar vender itens ainda associados a um pagamento pendente. Confirme no Mercado Pago que a preferência e eventuais boletos não podem mais ser pagos antes de repor manualmente a quantidade no produto. A preferência expira em 24 horas; boletos emitidos têm seu próprio prazo. Após um timeout ou reinício durante a criação, confira eventuais preferências duplicadas no provedor antes de repetir a operação. Não há liberação automática de estoque nem integração de estorno pelo painel.

## Publicar

Esta aplicação precisa de hospedagem que execute Node.js, disco/volume persistente e um único processo. Use um proxy HTTPS na frente do servidor; configure `HOST=0.0.0.0` apenas no ambiente de hospedagem, a origem pública exata e um volume privado em `DATA_DIR`. O proxy deve preservar o cabeçalho `Origin`. Não há autenticação baseada em cabeçalhos de identidade externos nesta edição; o painel usa senha e cookie de sessão próprio.

A publicação na **Vercel** usa a entrada `api/index.mjs`, os roteamentos em `vercel.json` e armazenamento privado compartilhado. Configure o Root Directory como `cafe-delicias`. O identificador Sites em `.openai/hosting.json` é de uma tentativa anterior e não participa da publicação Vercel. Consulte [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md).

## Verificações

```powershell
node --test
node --check server.mjs
node --check public/app.js
node --check public/admin.js
```

Os testes exercitam validação de estoque, quantidades, total calculado no servidor, persistência após reabertura, proteção do painel e contra requisições de outras origens, bloqueio sem credenciais, idempotência concorrente e confirmação assinada. A comunicação com o Mercado Pago é simulada apenas nos testes; nenhuma transação financeira real foi efetuada. A vitrine foi inspecionada em navegador nos layouts desktop e celular.

Referências oficiais: [Checkout Pro](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/overview), [meios de pagamento](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/additional-settings/payment-methods), [notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications).
