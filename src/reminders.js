// Pedidos que terminaron la compra pero no enviaron el mensaje de WhatsApp:
// se sincronizan desde Shopify, se listan en el panel y (opcional) reciben un recordatorio.
import { config, shopifyReady, whatsappReady } from './config.js';
import * as db from './db.js';
import * as shopify from './shopify.js';
import * as wa from './whatsapp.js';
import { money } from './orders.js';
import { requestPrepay } from './agent.js';

const R = config.reminders;

// Convierte el teléfono del pedido al formato de WhatsApp (solo dígitos con código de país)
export function toWaId(phone) {
  let d = shopify.digits(phone).replace(/^00/, '');
  const cc = R.defaultCountryCode;
  if (!d) return null;
  if (cc === '56') {
    if (d.length === 11 && d.startsWith('56')) return d;
    if (d.length === 9 && d.startsWith('9')) return `56${d}`;
    if (d.length === 8 && !d.startsWith('2')) return `569${d}`; // 8 dígitos: celular sin el 9 (los que empiezan en 2 son fijos)
    if (d.length === 10 && d.startsWith('0')) return `56${d.slice(1)}`;
  }
  if (d.startsWith(cc)) return d.length >= 10 ? d : null;
  return d.length >= 10 ? d : null;
}

function inQuietHours() {
  const m = String(R.quietHours).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: config.store.timezone }).format(new Date()));
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

export const remindersEnabled = () => Boolean(R.template && (whatsappReady() || config.demo));

export async function syncOrders() {
  if (!shopifyReady() && !config.demo) return { skipped: true };
  // Solo se recuerdan pedidos creados después de activar el sistema (nunca los antiguos)
  if (!db.getSetting('reminders_since')) db.setSetting('reminders_since', new Date().toISOString());
  const list = await shopify.listRecentOrders(config.sync.days);
  for (const o of list) {
    db.upsertShopOrder(o);
    // Historial escrito por la revisión programada → actualizar el pedido y, si es bajo y ya confirmó, pedir transferencia
    const linked = db.getOrder(o.id);
    if (linked && o.history?.status) {
      db.updateOrderHistory(o.id, o.history);
      const cur = db.getOrder(o.id);
      if (cur.hist_status === 'bajo' && cur.status === 'confirmed' && !cur.prepay_requested_at && !cur.prepaid_at && !cur.prepay_error) {
        try { await requestPrepay(cur); } catch (e) { console.error('[prepago]', e.message); }
      }
    }
  }
  db.setSetting('last_sync_at', new Date().toISOString());
  return { count: list.length };
}

export async function sendReminder(orderId, { manual = false } = {}) {
  const s = db.getShopOrder(orderId);
  if (!s) throw new Error('Pedido no encontrado');
  if (!remindersEnabled()) throw new Error('Configura REMINDER_TEMPLATE con el nombre de tu plantilla aprobada en Meta.');
  const to = toWaId(s.phone);
  if (!to) {
    db.updateShopOrder(orderId, { reminder_status: 'failed', reminder_error: `Teléfono no válido: ${s.phone || 'vacío'}`, reminder_at: db.now() });
    throw new Error(`El pedido ${s.name} no tiene un teléfono válido`);
  }
  // Se vincula el pedido a esa conversación para que los botones de la plantilla funcionen
  db.upsertContact(to, s.customer_name?.split(' ')[0] || null);
  db.linkOrder({ id: s.id, name: s.name, customerName: s.customer_name, phone: s.phone, total: s.total, currency: s.currency, items: s.items, address: s.address, createdAt: s.created_at }, to, true);

  const values = { nombre: s.customer_name?.split(' ')[0] || '', pedido: s.name, total: money(s.total, s.currency), productos: s.items || '', direccion: s.address || '', tienda: config.store.name };
  const bodyParams = String(process.env.REMINDER_TEMPLATE_PARAMS ?? 'nombre,pedido,total').split(',').map((k) => k.trim()).filter(Boolean).map((k) => values[k] ?? '');
  const r = await wa.sendTemplate(to, {
    name: R.template,
    language: R.language,
    bodyParams,
    buttonPayloads: [`confirm:${s.id}`, `cancel_ask:${s.id}`],
    preview: `Recordatorio automático (plantilla "${R.template}") para confirmar el pedido ${s.name}`,
  }, manual ? 'human' : 'bot');
  db.updateShopOrder(orderId, { reminder_status: r.ok ? 'sent' : 'failed', reminder_error: r.ok ? null : r.error, reminder_at: db.now() });
  db.logEvent(to, s.id, r.ok ? 'reminder_sent' : 'reminder_failed', r.error || (manual ? 'manual' : 'auto'));
  if (!r.ok) throw new Error(r.error);
  return r;
}

export async function runAutoReminders() {
  if (!remindersEnabled() || inQuietHours()) return;
  const since = db.getSetting('reminders_since');
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const due = db.silentOrders({ olderThanMin: R.afterMinutes })
    .filter((o) => !o.reminder_status && o.created_at >= (since || db.now()) && o.created_at >= dayAgo);
  for (const o of due) {
    try { await sendReminder(o.id); } catch (e) { console.error('[recordatorio]', o.name, e.message); }
  }
}

export function startScheduler() {
  if (!shopifyReady() && !config.demo) {
    console.log('  Pedidos sin mensaje: desactivado (falta conectar Shopify)');
    return;
  }
  const tick = async () => {
    try { await syncOrders(); await runAutoReminders(); }
    catch (e) { console.error('[sync]', e.message); }
  };
  setTimeout(tick, 3000);
  setInterval(tick, Math.max(1, config.sync.everyMinutes) * 60e3);
  console.log(`  Pedidos sin mensaje: revisando Shopify cada ${config.sync.everyMinutes} min | recordatorio: ${remindersEnabled() ? `plantilla "${R.template}" a los ${R.afterMinutes} min` : 'desactivado'}`);
}
