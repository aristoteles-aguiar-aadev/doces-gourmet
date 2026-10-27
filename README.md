# Café & Delícias — Mãe e Filha

A loja está em [cafe-delicias](./cafe-delicias). Identidade visual inspirada na imagem fornecida: creme, rosa, chocolate, tipografia delicada e a marca original na seção de história.

Para iniciar no Windows, abra **iniciar-loja.cmd** ou execute:

```powershell
cd cafe-delicias
node server.mjs
```

- Loja: http://127.0.0.1:3180
- Painel: http://127.0.0.1:3180/admin
- Senha inicial: `cafe-delicias/data/acesso-admin.txt`, gerada no primeiro início. Uma senha definida por `ADMIN_PASSWORD` tem prioridade.

Não é necessário instalar dependências. Requer Node.js 20.12 ou superior. Veja [as instruções completas](./cafe-delicias/README.md) para cadastrar produtos, configurar pagamentos e publicar.

**Estado:** aplicação local funcional. Catálogo de demonstração. Pagamentos reais e publicação pública ainda não ativados.
