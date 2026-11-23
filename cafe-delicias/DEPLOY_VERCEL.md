# Vercel

Projeto: `aristoteles-aguiars-projects/doces-gourmet`.
Repositório: `aristoteles-aguiar-aadev/doces-gourmet`, branch `main`.
Root Directory: `cafe-delicias`. Node.js: `24.x`.

## Armazenamento

A produção usa o **Vercel Blob privado**, conectado na região São Paulo (`gru1`). O SDK usa a identidade OIDC do projeto e `BLOB_STORE_ID`; não exige copiar tokens para o código. O estado da loja fica em `system/loja.json`; as fotos ficam em `uploads/`.

Leituras usam `useCache: false` e alterações usam o ETag com `ifMatch`, repetindo a operação em caso de conflito. Isso evita sobrescrever alterações simultâneas de instâncias diferentes. O servidor local continua usando a pasta `data/`.

## Primeiro acesso administrativo

Se `ADMIN_PASSWORD` não estiver configurada, a primeira execução gera uma senha aleatória e a salva **somente no armazenamento privado**, em `system/acesso-admin.txt`. No painel Vercel, abra Storage → doces-gourmet-blob → Manage Blobs → system → acesso-admin.txt. Esse arquivo não tem rota pública no site.

O usuário padrão é `admin`. Para personalizá-lo, defina `ADMIN_USERNAME` em Production e faça um novo deploy.

Outra opção é definir `ADMIN_PASSWORD` nas variáveis privadas da Vercel e fazer um novo deploy. A senha precisa ter pelo menos 12 caracteres. A troca invalida as sessões anteriores. Nunca coloque a senha em `.env.example`, no código ou no repositório.

As sessões administrativas e a contagem de tentativas de login são persistidas no armazenamento compartilhado. Os tokens de sessão são salvos apenas em forma de hash e excluídos dos backups exportados.

## Pagamentos

Configure `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `PUBLIC_BASE_URL` em Production. Sem `PUBLIC_BASE_URL`, a origem principal é obtida de `VERCEL_PROJECT_PRODUCTION_URL`. O webhook é `/api/payments/webhook`.

Para abrir crédito, débito, Pix e boleto dentro da loja, configure `MP_TRANSPARENT_PUBLIC_KEY`, `MP_TRANSPARENT_ACCESS_TOKEN` e `MP_TRANSPARENT_WEBHOOK_SECRET` da aplicação Mercado Pago com Checkout Bricks (Payments API). Use as credenciais de teste e a URL HTTPS do deploy em Preview para homologar. Use as credenciais produtivas da aplicação em Production. Armazene o Access Token e a assinatura como segredos na Vercel.

Cadastre o evento **Pagamentos (legacy)** em `/api/payments/transparent-webhook` na aplicação do Checkout Transparente. Preserve a URL e as credenciais do Checkout Pro para conciliar pedidos já iniciados por ele. Cadastre também uma chave Pix na conta vendedora. Os cartões de débito e os limites de valor dependem dos meios habilitados pelo Mercado Pago para a conta.

O catálogo de exemplo bloqueia cobranças mesmo com credenciais. Substitua produtos, fotos, alergênicos, estoque e dados comerciais antes de desativar a demonstração no painel. Homologue as quatro modalidades com a conta Mercado Pago antes de vender.

## Verificação

`node --test` testa regras de compra, proteção do painel, persistência de sessão entre instâncias, conflito ETag e leitura/escrita privada de uploads. Os testes não acessam o Mercado Pago real. A Vercel instala `@vercel/blob` durante o deploy.

Limitações mantidas: taxa de entrega fixa por região, estoque reservado sem liberação automática para pedidos abandonados e ausência de estorno pelo painel. Blob mantém um documento de estado por loja; para alto volume, migre para banco transacional com índices.
