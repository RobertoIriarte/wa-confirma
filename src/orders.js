// Cambios de estado de pedidos: base local + etiquetas/cancelación en Shopify
import { config } from './config.js';
import * as db from './db.js';
import * as shopify from './shopify.js';

const T = config.shopify.tags;

export const money = (amount, currency) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: currency || 'CLP', maximumFractionDigits: currency === 'CLP' || !currency ? 0 : 2 }).format(n); }
  catch { return `${n} ${currency || ''}`.trim(); }
};

/**
 * status: confirmed | cancelled | pending
 * by: bot | ai | human
 * opts.cancelInShopify: cancela el pedido en Shopify (si no, solo etiqueta)
 */
export async function applyStatus(orderId, status, by, opts = {}) {
  const order = db.getOrder(orderId);
  if (!order) throw new Error('Pedido no encontrado');
  const warnings = [];
  try {
    if (status === 'confirmed') {
      await shopify.addTags(orderId, [T.confirmed]);
      await shopify.removeTags(orderId, [T.cancelled]);
    } else if (status === 'cancelled') {
      await shopify.addTags(orderId, [T.cancelled]);
      await shopify.removeTags(orderId, [T.confirmed]);
      const doCancel = opts.cancelInShopify ?? config.shopify.autoCancel;
      if (doCancel) {
        await shopify.cancelOrder(orderId, opts.note);
        db.logEvent(order.wa_id, orderId, 'shopify_cancelled', by);
      }
    } else if (status === 'pending') {
      await shopify.removeTags(orderId, [T.confirmed, T.cancelled]);
    }
  } catch (e) {
    console.error('[shopify]', e.message);
    warnings.push(`Shopify: ${e.message}`);
    db.logEvent(order.wa_id, orderId, 'shopify_error', e.message);
  }
  const updated = db.setOrderStatus(orderId, status, by);
  return { order: updated, warnings };
}

export async function flagForReview(orderId) {
  if (!orderId) return;
  try { await shopify.addTags(orderId, [T.review]); } catch (e) { console.error('[shopify]', e.message); }
}
export async function clearReview(orderId) {
  if (!orderId) return;
  try { await shopify.removeTags(orderId, [T.review]); } catch (e) { console.error('[shopify]', e.message); }
}
