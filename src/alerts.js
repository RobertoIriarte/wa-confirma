// Alertas para el equipo (no le escriben a la clienta, salvo el recordatorio de novedad):
//  1) Confirmado hace más de 24 h y no aparece en Dropi → "ingréselo en Dropi"
//  2) Cancelado por WhatsApp pero sigue activo en Dropi → "anúlelo en Dropi"
//  3) Envío detenido: más de 5 días sin cambios (preparando o en tránsito)
//  4) Novedad sin respuesta de la clienta en 24 h → un recordatorio a la clienta
// Las alertas suben la conversación en la bandeja (needs_human) con el motivo.
import { config } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import { dropiConnected, listOrders } from './dropi.js';
import { matchDropi, isDeadStatus } from './dropi-sync.js';
import { SHIP_LABEL } from './shipping.js';

for (const col of ['dropi_sync_error', 'alert_sync_err_at', 'dropi_order_id', 'dropi_status', 'alert_nodropi_at', 'alert_cancel_dropi_at', 'alert_stalled_for', 'nov_reminder_at']) {
  try { db.db.exec(`ALTER TABLE orders ADD COLUMN ${col} TEXT`); } catch { /* ya existe */ }
}

const H = 3600e3;
const A = {
  noDropiHours: Number(process.env.ALERT_NO_DROPI_HOURS || 24),
  stalledDays: Number(process.env.ALERT_STALLED_DAYS || 5),
  novedadHours: Number(process.env.NOVEDAD_REMINDER_HOURS || 24),
  everyMin: Number(process.env.ALERTS_EVERY_MINUTES || 30),
};
const ago = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
const ymd = (d) => d.toISOString().slice(0, 10);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const chileHour = () => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: config.store.timezone }).format(new Date()));
function quiet() {
  const m = String(config.reminders.quietHours).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])]; const h = chileHour();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

function raise(o, field, value, reason, type) {
  db.updateOrder(o.id, { [field]: value });
  const c = db.getContact(o.wa_id);
  if (c?.archived) db.unarchive(o.wa_id); // que se vea en la bandeja (el bot sigue pausado)
  db.updateContact(o.wa_id, { needs_human: 1, human_reason: reason });
  db.logEvent(o.wa_id, o.id, type, reason);
  console.log('[alerta]', o.name, reason);
}

let lastRun = 0;
export async function runAlerts({ force = false } = {}) {
  if (!force && Date.now() - lastRun < A.everyMin * 60e3) return;
  lastRun = Date.now();
  const since = new Date(Date.now() - 12 * 24 * H).toISOString();

  // ---- 0: Dropify no pudo crear el pedido en Dropi (etiqueta "Dropi Sync Error") → aviso inmediato al confirmar ----
  for (const o of db.db.prepare(`SELECT * FROM orders WHERE dropi_sync_error IS NOT NULL AND alert_sync_err_at IS NULL
      AND status = 'confirmed' AND ship_status IS NULL AND wa_id IS NOT NULL`).all()) {
    raise(o, 'alert_sync_err_at', db.now(), `Dropify no pudo crear el pedido ${o.name} en Dropi (${o.dropi_sync_error}). Créelo a mano en Dropi o reintente desde Dropify`, 'alert_sync_error');
    db.updateOrder(o.id, { alert_nodropi_at: db.now() }); // no repetir con la alerta de 24 h
  }

  // ---- 1 y 2: necesitan saber qué hay en Dropi ----
  if (dropiConnected()) {
    const noDropi = db.db.prepare(`SELECT * FROM orders WHERE status = 'confirmed' AND ship_status IS NULL AND alert_nodropi_at IS NULL
      AND wa_id IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at <= ? AND linked_at >= ?`).all(new Date(Date.now() - A.noDropiHours * H).toISOString(), since);
    const cancelled = db.db.prepare(`SELECT * FROM orders WHERE status = 'cancelled' AND alert_cancel_dropi_at IS NULL
      AND wa_id IS NOT NULL AND resolved_at >= ?`).all(new Date(Date.now() - 7 * 24 * H).toISOString());
    if (noDropi.length || cancelled.length) {
      try {
        const dropiOrders = await listOrders({ from: ymd(new Date(Date.now() - 13 * 24 * H)), until: ymd(new Date(Date.now() + 24 * H)) });
        const asShop = (o) => ({ id: o.id, phone: o.phone, createdAt: o.order_created_at || o.linked_at });
        const m1 = matchDropi(noDropi.map(asShop), dropiOrders);
        for (const o of noDropi) {
          const d = m1.get(o.id);
          if (d && !isDeadStatus(d.status)) { db.updateOrder(o.id, { dropi_order_id: String(d.order_id), dropi_status: d.status }); continue; }
          raise(o, 'alert_nodropi_at', db.now(), `Pedido ${o.name} confirmado hace más de ${A.noDropiHours} h y no aparece en Dropi: ingréselo para despacharlo`, 'alert_no_dropi');
        }
        const m2 = matchDropi(cancelled.map(asShop), dropiOrders);
        for (const o of cancelled) {
          const d = m2.get(o.id);
          if (!d || isDeadStatus(d.status)) { db.updateOrder(o.id, { alert_cancel_dropi_at: 'ok' }); continue; } // no está en Dropi o ya está anulado
          raise(o, 'alert_cancel_dropi_at', db.now(), `Pedido ${o.name} cancelado por la clienta, pero sigue activo en Dropi (pedido ${d.order_id}, ${d.status}): anúlelo en Dropi para que no se despache`, 'alert_cancel_dropi');
        }
      } catch (e) { console.error('[alertas] Dropi', e.message); }
    }
  }

  // ---- 3: envío detenido ----
  const stalled = db.db.prepare(`SELECT * FROM orders WHERE status != 'cancelled' AND ship_status IN ('preparado', 'en_transito')
    AND ship_updated_at IS NOT NULL AND ship_updated_at <= ? AND (alert_stalled_for IS NULL OR alert_stalled_for != ship_status || ':' || ship_updated_at)
    AND wa_id IS NOT NULL`).all(new Date(Date.now() - A.stalledDays * 24 * H).toISOString());
  for (const o of stalled) {
    const days = Math.floor(ago(o.ship_updated_at) / (24 * H));
    raise(o, 'alert_stalled_for', `${o.ship_status}:${o.ship_updated_at}`,
      `Envío del pedido ${o.name} detenido: lleva ${days} días en "${SHIP_LABEL[o.ship_status] || o.ship_status}"${o.ship_carrier ? ` con ${o.ship_carrier}` : ''}${o.ship_tracking ? ` (seguimiento ${o.ship_tracking})` : ''}. Revíselo con Dropi o la transportista`, 'alert_stalled');
  }

  // ---- 4: novedad sin respuesta → un recordatorio a la clienta ----
  if (!quiet()) {
    const nov = db.db.prepare(`SELECT o.*, c.last_inbound_at FROM orders o JOIN contacts c ON c.wa_id = o.wa_id
      WHERE o.ship_status = 'novedad' AND o.ship_notified = 'novedad' AND o.ship_notified_at IS NOT NULL
        AND o.nov_reminder_at IS NULL AND o.ship_notified_at <= ?`).all(new Date(Date.now() - A.novedadHours * H).toISOString());
    for (const o of nov) {
      if (o.last_inbound_at && o.last_inbound_at > o.ship_notified_at) { db.updateOrder(o.id, { nov_reminder_at: 'respondió' }); continue; }
      const who = first(o.customer_name);
      const carrier = o.ship_carrier || 'la transportista';
      const text = `Hola${who ? ' ' + who : ''} 💗 Le recordamos que ${carrier} no pudo entregar su pedido *${o.name}*. ¿Nos indica qué día y horario le acomoda para una nueva entrega, o si prefiere retirarlo en sucursal? Así evitamos que el pedido se devuelva.`;
      const open = ago(o.last_inbound_at) < 23.5 * H;
      let r;
      if (open) r = await wa.sendText(o.wa_id, text, 'bot');
      else if (config.shipping.templates.novedad) {
        r = await wa.sendTemplate(o.wa_id, { name: config.shipping.templates.novedad, language: config.reminders.language, bodyParams: [who, o.name, carrier], preview: text }, 'bot');
      } else r = { ok: false, error: 'sin plantilla de novedad' };
      if (r.retry) continue;
      db.updateOrder(o.id, { nov_reminder_at: r.ok ? db.now() : `error: ${r.error}` });
      db.logEvent(o.wa_id, o.id, r.ok ? 'novedad_reminder' : 'novedad_reminder_failed', r.error || '');
    }
  }
}
