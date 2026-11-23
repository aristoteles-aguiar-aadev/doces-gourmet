import {ShopError} from './shop.mjs';

export function paymentType(method) {
  if (method === 'credit') return 'credit_card';
  if (method === 'debit') return 'debit_card';
  if (method === 'pix') return 'bank_transfer';
  if (method === 'boleto') return 'ticket';
  return null;
}

export function supportsAmount(method, total) {
  const amount = total / 100;
  return amount >= Number(method.min_allowed_amount || 0) &&
    (!Number(method.max_allowed_amount) || amount <= Number(method.max_allowed_amount));
}

function cardInput(form, method) {
  const {token, issuer_id: issuerId} = form;
  const installments = Number(form.installments);
  if (typeof token !== 'string' || !/^[a-z0-9_-]{16,180}$/i.test(token)) {
    throw new ShopError('Confira os dados do cartão e tente novamente.');
  }
  if (!Number.isSafeInteger(installments) || installments < 1 || installments > (method === 'debit' ? 1 : 36)) {
    throw new ShopError('Selecione uma quantidade válida de parcelas.');
  }
  if (issuerId != null && issuerId !== '' && !/^\d{1,20}$/.test(String(issuerId))) {
    throw new ShopError('Selecione o emissor do cartão.');
  }

  return {token, installments, ...(issuerId != null && issuerId !== '' ? {issuer_id: String(issuerId)} : {})};
}

function payerIdentification(identification) {
  const type = identification?.type;
  const number = String(identification?.number ?? '').replace(/[.\s/-]/g, '');
  if (!((type === 'CPF' && /^\d{11}$/.test(number)) || (type === 'CNPJ' && /^\d{14}$/.test(number)))) {
    throw new ShopError('Informe o CPF ou CNPJ do pagador.');
  }
  return {type, number};
}

function billingAddress(address) {
  const zip_code = String(address?.zip_code ?? '').replace(/-/g, '');
  const street_name = String(address?.street_name ?? '').trim();
  const street_number = String(address?.street_number ?? '').trim();
  const neighborhood = String(address?.neighborhood ?? '').trim();
  const city = String(address?.city ?? '').trim();
  const federal_unit = String(address?.federal_unit ?? '').trim().toUpperCase();
  if (!/^\d{8}$/.test(zip_code) || !/^[A-Z]{2}$/.test(federal_unit) ||
      [street_name, street_number, neighborhood, city].some(value => !value || value.length > 150)) {
    throw new ShopError('Confira o endereço de cobrança do boleto.');
  }
  return {zip_code, street_name, street_number, neighborhood, city, federal_unit};
}

export function transparentPaymentInput(form, method, customer) {
  const paymentMethodId = form?.payment_method_id;
  if (typeof paymentMethodId !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(paymentMethodId)) {
    throw new ShopError('Selecione uma forma de pagamento válida.');
  }
  if ((method === 'pix' && paymentMethodId !== 'pix') || (method === 'boleto' && paymentMethodId !== 'bolbradesco')) {
    throw new ShopError('Meio de pagamento não corresponde ao pedido.');
  }

  const payer = {email: customer.email, identification: payerIdentification(form.payer?.identification)};
  if (method === 'credit' || method === 'debit') return {payment_method_id: paymentMethodId, payer, ...cardInput(form, method)};

  const [firstName, ...lastNames] = customer.name.split(/\s+/);
  payer.first_name = firstName;
  payer.last_name = lastNames.join(' ');
  if (method === 'boleto') payer.address = billingAddress(form.payer?.address);
  return {payment_method_id: paymentMethodId, payer};
}
