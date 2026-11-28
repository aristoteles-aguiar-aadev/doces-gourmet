import { randomUUID } from 'node:crypto';
import { ShopError } from './shop.mjs';
import { buildTransparentOrder } from './transparent-payment.mjs';

export async function createMercadoPagoOrder({
  form,
  method,
  customer,
  total,
  externalReference,
  stateId,
  idempotencyKey = randomUUID()
}, { accessToken = process.env.MP_TRANSPARENT_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN, paymentFetch = fetch } = {}) {
  if (!accessToken) throw new ShopError('Pagamentos não configurados.', 503);

  const body = buildTransparentOrder(form, method, customer, total, externalReference, stateId);
  const response = await paymentFetch('https://api.mercadopago.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const message = data?.message || data?.errors?.[0]?.message || data?.error;
    const error = new ShopError(message || 'Não foi possível criar o pedido no Mercado Pago.', 502);
    error.providerStatus = response.status;
    throw error;
  }

  return data;
}

export function normalizeMercadoPagoOrder(order) {
  const payment = order?.transactions?.payments?.[0];
  if (!payment) throw new ShopError('Resposta de pagamento inválida.', 502);

  const status = payment.status || order.status;
  const statusDetail = payment.status_detail || order.status_detail;
  const paymentMethod = payment.payment_method;
  const result = {
    orderId: order.id,
    paymentId: payment.id,
    status,
    statusDetail,
    method: paymentMethod?.type,
    methodId: paymentMethod?.id,
    raw: order
  };

  if (order.status === 'refunded' || status === 'refunded') return { ...result, outcome: 'refunded' };
  if (order.status === 'charged_back' || status === 'charged_back') return { ...result, outcome: 'charged_back' };

  if (status === 'processed' && statusDetail === 'accredited') {
    return { ...result, outcome: 'approved' };
  }

  if (status === 'processing' || status === 'in_review') {
    return { ...result, outcome: 'processing' };
  }

  if (status === 'action_required' && statusDetail === 'waiting_transfer') {
    return {
      ...result,
      outcome: 'pending_payment',
      ticketUrl: paymentMethod?.ticket_url ?? null,
      qrCode: paymentMethod?.qr_code ?? null,
      qrCodeBase64: paymentMethod?.qr_code_base64 ?? null
    };
  }

  if (status === 'action_required' && statusDetail === 'waiting_payment') {
    return {
      ...result,
      outcome: 'pending_payment',
      ticketUrl: paymentMethod?.ticket_url ?? null,
      barcode: paymentMethod?.barcode ?? null
    };
  }

  if (status === 'action_required' && statusDetail === 'waiting_capture') {
    return { ...result, outcome: 'authorized' };
  }

  if (status === 'failed') return { ...result, outcome: 'rejected' };
  if (status === 'canceled' || status === 'expired') return { ...result, outcome: 'canceled' };

  return { ...result, outcome: 'unknown' };
}

export async function createAndNormalizeOrder(input, options) {
  const order = await createMercadoPagoOrder(input, options);
  return normalizeMercadoPagoOrder(order);
}
