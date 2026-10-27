// Seguimiento de pedidos que no se confirman.
//  Caso 1 (la clienta escribió por Releasit y no confirmó): dentro de las 24 h se puede escribir libre.
//    · 3 h después de su último mensaje: recordatorio con botones
//    · ~20 h después: último aviso con botones
//  Caso 2 (no escribió y no respondió la plantilla de los 30 min):
//    · al día siguiente desde las 10:00: se reenvía la plantilla de confirmación (último aviso)
//  Si sigue sin responder: queda "No responde" (para el equipo + etiqueta en Shopify). Nunca se cancela solo.
//  Nada se envía en horario silencioso (22:00–9:00).
import { config, whatsappReady } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import * as shopify from './shopify.js';
import { money } from './orders.js';

for (const col of ['fu1_at', 'fu2_at', 'fu_tpl_at', 'no_reply_at']) {
  try { db.db.exec(`ALTER TABLE orders ADD COLUMN ${col} TEXT`); } catch { /* ya existe */ }
}

const H = 3600e3;
const F = {
  first: Number(process.env.FOLLOWUP_FIRST_HOURS || 3) * H,
  last: Number(process.env.FOLLOWUP_LAST_HOURS || 20) * H,
  tplHour: Number(process.env.FOLLOWUP_TEMPLATE_HOUR || 10),
  noReplyAfterTpl: 24 * H,
  enabled: (process.env.FOLLOWUPS ?? 'on') !== 'off',
};
export const NO_REPLY_TAG = process.env.TAG_NO_REPLY || 'WA-SIN-RESPUESTA';

const TZ = () => config.store.timezone;
const chileParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
const chileDay = (d) => { const p = chileParts(d); return `${p.year}-${p.month}-${p.day}`; };
const chileHour = () => Number(chileParts().hour);
function quiet() {
  const m = String(config.reminders.quietHours).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])]; const h = chileHour();
  return from > to ? h >= from || h < to : h >= from && h < to;
}
const ago = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';

const buttons = (o) => [
  { id: `confirm:${o.id}`, title: '✅ Sí, confirmar' },
  { id: `cancel_ask:${o.id}`, title: '❌ Cancelar pedido' },
];

function nudgeText(o, last) {
  const who = first(o.customer_name);
  const total = o.total ? ` por *${money(o.total, o.currency)}*` : '';
  return last
    ? `Hola${who ? ' ' + who : ''}, su pedido *${o.name}* sigue pendiente de confirmación. Si no lo confirma hoy, no podremos despacharlo. ¿Lo enviamos? 👇`
    : `Hola${who ? ' ' + who : ''} 💗 Le escribimos para confirmar su pedido *${o.name}*${total}, con pago contra entrega. ¿Lo despachamos? 👇`;
}

async function markNoReply(o) {
  db.updateOrder(o.id, { no_reply_at: db.now() });
  db.updateContact(o.wa_id, { needs_human: 1, human_reason: `No responde la confirmación del pedido ${o.name}: decida si llamarla o cancelar` });
  db.logEvent(o.wa_id, o.id, 'no_reply', o.name);
  try { await shopify.addTags(o.id, [NO_REPLY_TAG]); } catch (e) { console.error('[seguimiento] etiqueta', o.name, e.message); }
}

export async function runFollowups() {
  if (!F.enabled || (!whatsappReady() && !config.demo)) return;
  const rows = db.db.prepare(`SELECT o.*, c.last_inbound_at, c.bot_paused, c.archived, s.reminder_status, s.reminder_at
    FROM orders o JOIN contacts c ON c.wa_id = o.wa_id LEFT JOIN shop_orders s ON s.id = o.id
    WHERE o.status = 'pending' AND o.no_reply_at IS NULL AND o.linked_at >= ?`).all(new Date(Date.now() - 4 * 24 * H).toISOString());
  for (const o of rows) {
    if (o.bot_paused || o.archived) continue; // el equipo ya está atendiendo o la conversación está cerrada
    try {
      if (o.last_inbound_at) {
        // ---- Caso 1: la clienta escribió ----
        const since = Math.min(ago(o.last_inbound_at), ago(o.linked_at));
        const inWindow = ago(o.last_inbound_at) < 23.5 * H;
        if (!inWindow) {
          if (ago(o.last_inbound_at) >= 24 * H) await markNoReply(o);
          continue;
        }
        if (quiet()) continue;
        if (!o.fu1_at && since >= F.first) {
          const r = await wa.sendButtons(o.wa_id, nudgeText(o, false), buttons(o), 'bot');
          if (r.ok) { db.updateOrder(o.id, { fu1_at: db.now() }); db.logEvent(o.wa_id, o.id, 'followup', 'recordatorio 1'); }
        } else if (o.fu1_at && !o.fu2_at && ago(o.last_inbound_at) >= F.last && ago(o.fu1_at) >= 2 * H) {
          const r = await wa.sendButtons(o.wa_id, nudgeText(o, true), buttons(o), 'bot');
          if (r.ok) { db.updateOrder(o.id, { fu2_at: db.now() }); db.logEvent(o.wa_id, o.id, 'followup', 'último aviso'); }
        }
      } else if (o.reminder_status === 'sent' && o.reminder_at) {
        // ---- Caso 2: nunca escribió; ya recibió la plantilla de los 30 min ----
        if (!o.fu_tpl_at) {
          const nextDay = chileDay(new Date()) > chileDay(new Date(o.reminder_at));
          const h = chileHour();
          if (!nextDay || h < F.tplHour || h >= 21 || quiet() || !config.reminders.template) continue;
          const values = { nombre: first(o.customer_name), pedido: o.name, total: money(o.total, o.currency), productos: o.items || '', direccion: o.address || '', tienda: config.store.name };
          const bodyParams = String(process.env.REMINDER_TEMPLATE_PARAMS ?? 'nombre,pedido,total').split(',').map((k) => k.trim()).filter(Boolean).map((k) => values[k] ?? '');
          const r = await wa.sendTemplate(o.wa_id, {
            name: config.reminders.template, language: config.reminders.language, bodyParams,
            buttonPayloads: [`confirm:${o.id}`, `cancel_ask:${o.id}`],
            preview: `Último aviso automático (plantilla "${config.reminders.template}") para confirmar el pedido ${o.name}`,
          }, 'bot');
          if (r.ok) { db.updateOrder(o.id, { fu_tpl_at: db.now() }); db.logEvent(o.wa_id, o.id, 'followup', 'plantilla día siguiente'); }
        } else if (ago(o.fu_tpl_at) >= F.noReplyAfterTpl) {
          await markNoReply(o);
        }
      }
    } catch (e) { console.error('[seguimiento]', o.name, e.message); }
  }
}
