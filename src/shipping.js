// Estado del envío (Dropi → Shopify → aquí) y avisos a la clienta.
//
// Contrato con la tarea programada "Estado de envío Dropi → Shopify":
//   Etiquetas: ENVIO-PREPARADO | ENVIO-EN-TRANSITO | ENVIO-EN-REPARTO | ENVIO-NOVEDAD | ENVIO-ENTREGADO | ENVIO-DEVUELTO
//   Nota:      "Envío Dropi: EN_REPARTO (Starken, seguimiento 279921891), actualizado 17-10-2026 13:08"
import { config, whatsappReady } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import { money } from './orders.js';

export const SHIP_TAGS = {
  'ENVIO-PREPARADO': 'preparado',
  'ENVIO-EN-TRANSITO': 'en_transito',
  'ENVIO-EN-REPARTO': 'en_reparto',
  'ENVIO-NOVEDAD': 'novedad',
  'ENVIO-ENTREGADO': 'entregado',
  'ENVIO-DEVUELTO': 'devuelto',
};
export const SHIP_LABEL = {
  preparado: 'Preparando despacho', en_transito: 'En tránsito', en_reparto: 'En reparto',
  novedad: 'Novedad en la entrega', entregado: 'Entregado', devuelto: 'Devuelto',
};

// "17-10-2026 13:08" en hora de Chile → ISO
function chileToISO(s) {
  const m = String(s || '').match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const asUTC = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  // diferencia entre UTC y la hora de la tienda en ese momento
  const local = new Date(new Date(asUTC).toLocaleString('en-US', { timeZone: config.store.timezone }));
  const utc = new Date(new Date(asUTC).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(asUTC + (utc - local)).toISOString();
}

export function parseShipping(tags = [], note = '') {
  const t = (tags || []).map((x) => String(x).toUpperCase());
  const tag = Object.keys(SHIP_TAGS).find((k) => t.includes(k));
  const line = String(note || '').split('\n').find((l) => /env[ií]o dropi:/i.test(l)) || '';
  const body = line.replace(/^.*?env[ií]o dropi:\s*/i, '').trim();
  const m = body.match(/^(.*?)\s*\(([^,)]*)(?:,\s*([^)]*))?\)(?:,\s*actualizado\s*(.+))?$/i);
  const tracking = m?.[3]?.match(/seguimiento\s+(\S+)/i)?.[1] || null;
  return {
    status: tag ? SHIP_TAGS[tag] : null,
    raw: (m?.[1] || body || '').replace(/_/g, ' ').trim() || null,
    carrier: m?.[2]?.trim() || null,
    tracking,
    updatedAt: chileToISO(m?.[4]),
  };
}

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const within24h = (iso) => iso && Date.now() - new Date(iso) < 23.5 * 3600e3;

function inQuietHours() {
  const m = String(config.reminders.quietHours).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: config.store.timezone }).format(new Date()));
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

// Motivo de la novedad en palabras simples
function novedadText(raw) {
  const r = String(raw || '').toUpperCase();
  if (/NADIE/.test(r)) return 'no encontró a nadie en el domicilio';
  if (/INUBICABLE|FALTAN DATOS|COMUNA ERRADA|CAMBIO DE DOMICILIO/.test(r)) return 'no pudo ubicar la dirección de entrega';
  if (/SIN ACCESO|OFICINA CERRADA/.test(r)) return 'no pudo acceder al lugar de entrega';
  return 'tuvo un inconveniente con la entrega';
}

function noticeText(o) {
  const who = firstName(o.customer_name);
  const hi = `Hola${who ? ' ' + who : ''} 💗`;
  const carrier = o.ship_carrier || 'la transportista';
  const raw = String(o.ship_raw || '').toUpperCase();
  switch (o.ship_status) {
    case 'en_transito':
      return `${hi} Su pedido *${o.name}* ya va en camino con ${carrier} 🚚${o.ship_tracking ? `\nN° de seguimiento: *${o.ship_tracking}*` : ''}\nLe avisaremos el día que salga a reparto.`;
    case 'en_reparto':
      return `${hi} ¡Su pedido *${o.name}* sale hoy a reparto con ${carrier}! 🛵\nPor favor, procure que alguien esté en el domicilio para recibirlo y tenga listo el pago${o.total ? ` de *${money(o.total, o.currency)}*` : ''}.`;
    case 'novedad':
      if (/SUCURSAL|A RETIRAR/.test(raw)) {
        return `${hi} Su pedido *${o.name}* está disponible para retiro en la sucursal de ${carrier}${o.ship_tracking ? ` (seguimiento *${o.ship_tracking}*)` : ''}. Si prefiere que se lo volvamos a enviar a domicilio, escríbanos por aquí y lo coordinamos.`;
      }
      return `${hi} ${carrier} nos informa que ${novedadText(raw)} al intentar entregar su pedido *${o.name}*. ¿Nos ayuda a coordinar una nueva entrega? Indíquenos qué día y horario le acomoda, o si prefiere retirarlo en sucursal.`;
    case 'entregado':
      return `${hi} Vemos que su pedido *${o.name}* ya fue entregado. ¡Muchas gracias por comprar en ${config.store.name}! Cualquier consulta, estamos por aquí.`;
    default:
      return null;
  }
}

// Guarda el estado del envío de un pedido de Shopify ya vinculado a una conversación
export function updateShipping(orderId, s) {
  const cur = db.getOrder(orderId);
  if (!cur || !s?.status) return false;
  const same = cur.ship_status === s.status && (cur.ship_raw || null) === (s.raw || null) && (cur.ship_tracking || null) === (s.tracking || null);
  if (same) return false;
  db.updateOrder(orderId, { ship_status: s.status, ship_raw: s.raw, ship_carrier: s.carrier, ship_tracking: s.tracking, ship_updated_at: s.updatedAt || db.now() });
  db.logEvent(cur.wa_id, orderId, 'shipping', `${s.status}${s.raw ? ` (${s.raw})` : ''}`);
  if (cur.ship_status !== s.status && ['novedad', 'devuelto'].includes(s.status) && cur.wa_id) {
    const what = s.status === 'novedad' ? `Novedad en el envío: ${s.raw || 'sin detalle'}` : `Pedido devuelto: ${s.raw || 'sin detalle'}`;
    db.updateContact(cur.wa_id, { needs_human: 1, human_reason: `${what}${s.carrier ? ` (${s.carrier}${s.tracking ? ` ${s.tracking}` : ''})` : ''}` });
  }
  return true;
}

const S = () => config.shipping;
const pending = (o) => o.ship_status && S().notify.includes(o.ship_status) && o.ship_notified !== o.ship_status && o.status !== 'cancelled' && o.wa_id;
const fresh = (o) => !o.ship_updated_at || Date.now() - new Date(o.ship_updated_at) < S().freshHours * 3600e3;

export async function sendShippingNotice(o, { manual = false } = {}) {
  const text = noticeText(o);
  if (!text) return { ok: false, error: 'Este estado no tiene aviso' };
  const contact = db.getContact(o.wa_id);
  let r;
  if (within24h(contact?.last_inbound_at)) {
    r = await wa.sendText(o.wa_id, text, manual ? 'human' : 'bot');
  } else if (S().templates[o.ship_status]) {
    const values = { nombre: firstName(o.customer_name), pedido: o.name, transportista: o.ship_carrier || '', seguimiento: o.ship_tracking || 'sin seguimiento', total: money(o.total, o.currency), tienda: config.store.name };
    const params = (S().templateParams[o.ship_status] || 'nombre,pedido,transportista,seguimiento').split(',').map((k) => values[k.trim()] ?? '');
    r = await wa.sendTemplate(o.wa_id, { name: S().templates[o.ship_status], language: config.reminders.language, bodyParams: params, preview: text }, manual ? 'human' : 'bot');
  } else {
    r = { ok: false, error: 'Pasaron más de 24 h desde su último mensaje y no hay plantilla de Meta para este aviso' };
  }
  db.updateOrder(o.id, { ship_notified: o.ship_status, ship_notified_at: r.ok ? db.now() : null, ship_notify_error: r.ok ? null : r.error });
  db.logEvent(o.wa_id, o.id, r.ok ? 'ship_notice_sent' : 'ship_notice_failed', `${o.ship_status}${r.ok ? '' : `: ${r.error}`}`);
  return r;
}

// Envía los avisos pendientes (se llama después de cada sincronización con Shopify)
export async function runShippingNotices() {
  if (!S().notify.length || (!whatsappReady() && !config.demo) || inQuietHours()) return;
  const rows = db.db.prepare("SELECT * FROM orders WHERE ship_status IS NOT NULL AND status != 'cancelled'").all();
  for (const o of rows) {
    if (!pending(o)) continue;
    if (!fresh(o)) { db.updateOrder(o.id, { ship_notified: o.ship_status, ship_notify_error: 'Aviso omitido: el estado tenía más de ' + S().freshHours + ' h' }); continue; }
    try { await sendShippingNotice(o); } catch (e) { console.error('[envío]', o.name, e.message); }
  }
}
