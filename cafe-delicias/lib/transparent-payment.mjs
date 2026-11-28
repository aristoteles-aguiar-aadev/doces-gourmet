import { ShopError } from './shop.mjs';

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
  const { token, issuer_id: issuerId } = form;
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

  return {
    token,
    installments,
    ...(issuerId != null && issuerId !== '' ? { issuer_id: String(issuerId) } : {})
  };
}

function payerIdentification(identification) {
  const type = identification?.type;
  const number = String(identification?.number ?? '').replace(/[.\s/-]/g, '');

  if (!((type === 'CPF' && /^\d{11}$/.test(number)) || (type === 'CNPJ' && /^\d{14}$/.test(number)))) {
    throw new ShopError('Informe o CPF ou CNPJ do pagador.');
  }

  return { type, number };
}

function billingAddress(address) {
  const zip_code = String(address?.zip_code ?? '').replace(/-/g, '');
  const street_name = String(address?.street_name ?? '').trim();
  const street_number = String(address?.street_number ?? '').trim();
  const neighborhood = String(address?.neighborhood ?? '').trim();
  const city = String(address?.city ?? '').trim();
  const state = String(address?.federal_unit ?? address?.state ?? '').trim().toUpperCase();

  if (
    !/^\d{8}$/.test(zip_code) ||
    !/^[A-Z]{2}$/.test(state) ||
    [street_name, street_number, neighborhood, city].some(v => !v || v.length > 150)
  ) {
    throw new ShopError('Confira o endereço de cobrança do boleto.');
  }

  return { zip_code, street_name, street_number, neighborhood, city, state };
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new ShopError('Informe o nome do pagador.');
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' ') || parts[0]
  };
}

function buildPayer(form, method, customer) {
  const payer = {
    email: customer.email,
    identification: payerIdentification(form?.payer?.identification),
    ...splitName(customer.name)
  };

  if (method === 'boleto') {
    payer.address = billingAddress(form?.payer?.address);
  }

  return payer;
}

function buildPaymentMethod(form, method) {
  const id = form?.payment_method_id;
  const type = paymentType(method);

  if (typeof id !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(id) || !type) {
    throw new ShopError('Selecione uma forma de pagamento válida.');
  }

  if (method === 'pix' && id !== 'pix') {
    throw new ShopError('Meio de pagamento não corresponde ao pedido.');
  }

  const payment_method = { id, type };

  if (method === 'credit' || method === 'debit') {
    Object.assign(payment_method, cardInput(form, method));
  }

  return payment_method;
}

export function transparentPaymentInput(form, method, customer) {
  const { id, type, ...card } = buildPaymentMethod(form, method);
  const payer = { email: customer.email, identification: payerIdentification(form?.payer?.identification) };

  if (type === 'credit_card' || type === 'debit_card') return { payment_method_id: id, payer, ...card };

  const [firstName, ...lastNames] = customer.name.split(/\s+/);
  payer.first_name = firstName;
  payer.last_name = lastNames.join(' ');
  if (method === 'boleto') {
    if (id !== 'bolbradesco') throw new ShopError('Meio de pagamento não corresponde ao pedido.');
    const { state, ...address } = billingAddress(form?.payer?.address);
    payer.address = { ...address, federal_unit: state };
  }
  return { payment_method_id: id, payer };
}

export function buildTransparentOrder(form, method, customer, total, externalReference, stateId) {
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new ShopError('Valor do pedido inválido.');
  }

  const amount = (total / 100).toFixed(2);
  const payer = buildPayer(form, method, customer);
  const payment_method = buildPaymentMethod(form, method);
  if (method === 'boleto') {
    payment_method.id = 'boleto';
    stateId ??= `BR-${payer.address.state}`;
  }
  if (stateId !== undefined && (typeof stateId !== 'string' || !/^BR-[A-Z]{2}$/.test(stateId))) {
    throw new ShopError('Informe um estado válido para o pagamento.');
  }

  return {
    type: 'online',
    processing_mode: 'automatic',
    external_reference: externalReference,
    total_amount: amount,
    payer,
    ...(stateId === undefined ? {} : { config: { location: { state_id: stateId } } }),
    transactions: {
      payments: [
        {
          amount,
          payment_method
        }
      ]
    }
  };
}
