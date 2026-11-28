import { createAndNormalizeOrder } from './mercado-pago-orders.mjs';
import { ShopError } from './shop.mjs';
import { paymentType } from './transparent-payment.mjs';

export async function createCheckoutOrder({ form, order, stateId }, options) {
  const payment = await createAndNormalizeOrder({
    form,
    method: order.method,
    customer: order.customer,
    total: order.total,
    externalReference: order.id,
    stateId,
    idempotencyKey: order.id
  }, options);

  return checkoutOrderPayment(payment, order);
}

export function checkoutOrderPayment({ raw, ...payment }, order) {
  if (raw.external_reference !== order.id || Number(raw.total_amount) !== order.total / 100 ||
      (raw.currency_id && raw.currency_id !== 'BRL') ||
      payment.method !== paymentType(order.method) || !payment.orderId || !payment.paymentId) {
    throw new ShopError('A resposta do Mercado Pago não corresponde ao pedido.', 502);
  }

  return payment;
}
