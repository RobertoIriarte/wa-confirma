// Tareas con Dropi que antes hacían las tareas programadas de Claude (ahora sin gastar tokens):
//  1) Historial de la clienta apenas entra el pedido → etiqueta HIST-* + línea "Historial Dropi:" en Shopify
//  2) Estado del envío cada 30 min → etiqueta ENVIO-* + línea "Envío Dropi:" en Shopify, y aviso a la clienta
// Escribe en Shopify con el mismo formato de antes, así el resto del bot no cambia.
import { config } from './config.js';
import * as db from './db.js';
import * as shopify from './shopify.js';
import { dropiConnected, fingerprint, listOrders } from './dropi.js';
import { HISTORY_TAGS, parseHistory } from './history.js';
import { parseShipping, updateShipping } from './shipping.js';

const TZ = () => config.store.timezone;
function chileNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}
const chileHour = () => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ() }).format(new Date()));
const ymd = (d) => d.toISOString().slice(0, 10);

// +56 9 8625 1583 → 986251583
export function nationalPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('56') && d.length === 11) d = d.slice(2);
  if (d.length === 8) d = `9${d}`;
  return d.length === 9 ? d : null;
}

// Reemplaza la línea que empieza con `prefix` o la agrega al final, sin tocar el resto de la nota
export function upsertNoteLine(note, prefix, line) {
  const lines = String(note || '').split('\n');
  const i = lines.findIndex((l) => l.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  if (i >= 0) { lines[i] = line; return lines.join('\n'); }
  const base = String(note || '').replace(/\s+$/, '');
  return base ? `${base}\n${line}` : line;
}

// ---------- 1) historial ----------
const histTried = new Map(); // pedido -> momento del último intento fallido

export async function checkHistory(list) {
  if (!dropiConnected()) return;
  const maxAge = 3 * 86400e3;
  const targets = list.filter((o) => !o.cancelled && Date.now() - new Date(o.createdAt) < maxAge
    && !(o.tags || []).some((t) => /^HIST-/i.test(t)) && nationalPhone(o.phone)
    && !(histTried.get(o.id) > Date.now() - 10 * 60e3));
  if (!targets.length) return;
  const byPhone = new Map();
  for (const o of targets) {
    const phone = nationalPhone(o.phone);
    let fp = byPhone.get(phone);
    if (!fp) {
      try { fp = await fingerprint(phone); byPhone.set(phone, fp); }
      catch (e) { console.error('[dropi historial]', o.name, e.message); histTried.set(o.id, Date.now()); continue; }
    }
    const d = Number(fp.delivery_probability) || 0;
    const r = Number(fp.return_probability) || 0;
    let status, line;
    if (fp.notFound || /sin registro/i.test(fp.buyer_type || '') || d + r === 0) {
      status = 'sin_registro';
      line = `Historial Dropi: sin registro, revisado ${chileNow()}`;
    } else {
      const pos = Math.round((d / (d + r)) * 100);
      status = pos >= config.history.minRate ? 'ok' : 'bajo';
      line = `Historial Dropi: ${pos}% positivo (entregas ${Math.round(d)}%, devoluciones ${Math.round(r)}%), revisado ${chileNow()}`;
    }
    try {
      const note = upsertNoteLine(o.note, 'Historial Dropi:', line);
      await shopify.addTags(o.id, [HISTORY_TAGS[status]]);
      await shopify.setNote(o.id, note);
      o.tags = [...(o.tags || []), HISTORY_TAGS[status]];
      o.note = note;
      o.history = parseHistory(o.tags, o.note);
      db.logEvent(null, null, 'dropi_history', `${o.name}: ${line.replace(/^Historial Dropi:\s*/, '')}`);
      console.log('[dropi historial]', o.name, status);
    } catch (e) { console.error('[dropi historial] Shopify', o.name, e.message); histTried.set(o.id, Date.now()); }
  }
}

// ---------- 2) estado del envío ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[_\s]+/g, ' ').trim();
const STATUS_GROUPS = {
  'ENVIO-PREPARADO': ['GENERANDO GUIA', 'GUIA GENERADA', 'PREPARADO PARA TRANSPORTADORA'],
  'ENVIO-EN-TRANSITO': ['ENTREGADO A TRANSPORTADORA', 'EN TRANSITO', 'CARGA EN TRANSITO', 'EN RETIRO', 'RETIRADO', 'RECOGIDO POR DROPI', 'EN BODEGA DROPI', 'RECIBIDO POR DROPI', 'CD BLUE', 'ADMITIDA EN SUCURSAL', 'PICK UP HUB', 'ARRIBADO', 'ARRIBADO EN AGENCIA', 'INGRESO CAMION', 'TRANSFERIDO DESDE/HACIA', 'MOVIMIENTO DE DETALLE DE RUTEO', 'MOVIMIENTO DE CLASIFICACION DE RUTEO', 'DESPACHO CARGA RESTRINGIDA', 'AS CARGA VALORADA', 'IC CARGA VALORADA', 'EN PLANTA DE PROCESAMIENTO', 'NOVEDAD SOLUCIONADA'],
  'ENVIO-EN-REPARTO': ['EN REPARTO', 'EN CAMINO AL DESTINATARIO', 'EN CAMINO 2DA VISITA'],
  'ENVIO-NOVEDAD': ['NOVEDAD', 'PROBLEMAS DE ENTREGA', 'NADIE EN CASA', 'NADIE 2DA VISITA', 'SIN ACCESO', 'CAMBIO DE DOMICILIO', 'OFICINA CERRADA', 'FALTAN DATOS PARA LA ENTREGA', 'DIRECCION INUBICABLE', 'COMUNA ERRADA', 'PIEZA FALTANTE', 'PROBLEMA COBRO', 'PARA SOLUCION', 'DISPONIBLE EN SUCURSAL', 'A RETIRAR'],
  'ENVIO-ENTREGADO': ['ENTREGADO', 'ENTREGADO 2DA VISITA'],
  'ENVIO-DEVUELTO': ['DEVOLUCION', 'DEVUELTO', 'EN DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'DEVOLUCION ENTREGADA', 'DEVOLUCION A REMITENTE', 'EN CAMINO PARA EL REMITENTE', 'DEVOLVIENDO A PLANTA DE PROCESAMIENTO', 'DEVUELTO AL CLIENTE', 'NOVEDAD EN DEVOLUCION', 'DESTINATARIO RECHAZA ENTREGA', 'RECHAZADO POR EL COMPRADOR', 'REHUZA PRODUCTO', 'PRODUCTO NO CORRESPONDE'],
  none: ['PENDIENTE', 'PENDIENTE CONFIRMACION', 'ERROR GENERANDO GUIA', 'CANCELADO', 'RECHAZADO', 'GUIA ANULADA', 'CANCELADA', 'INDEMNIZADA POR DROPI', 'FINALIZADO POR RETENCION', 'PROCESO FINALIZADO', 'RECIBIDO PAU', 'RECLAMADO POR CLIENTE'],
};
const STATUS_TAG = new Map(Object.entries(STATUS_GROUPS).flatMap(([tag, list]) => list.map((s) => [norm(s), tag])));
export const shipTagFor = (status) => STATUS_TAG.has(norm(status)) ? STATUS_TAG.get(norm(status)) : undefined; // undefined = desconocido, 'none' = sin etiqueta
const DEAD = new Set(['CANCELADO', 'RECHAZADO', 'GUIA ANULADA', 'CANCELADA'].map(norm));
const cap = (s) => { const t = String(s || '').trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : 'Transportadora'; };

let lastShipRun = 0;
export async function syncShipping({ force = false } = {}) {
  if (!dropiConnected()) return { skipped: 'Dropi sin conectar' };
  const every = Number(process.env.DROPI_SHIP_MINUTES || 30) * 60e3;
  if (!force && Date.now() - lastShipRun < every) return { skipped: 'intervalo' };
  const h = chileHour();
  if (!force && (h < 7 || h >= 22)) return { skipped: 'fuera de horario' };
  lastShipRun = Date.now();

  const shopOrders = (await shopify.listShippingCandidates(10)).filter((o) => !o.cancelled);
  if (!shopOrders.length) return { checked: 0 };
  const dropiOrders = await listOrders({ from: ymd(new Date(Date.now() - 11 * 86400e3)), until: ymd(new Date(Date.now() + 86400e3)) });

  // Dropi por teléfono
  const byPhone = new Map();
  for (const d of dropiOrders) {
    const p = nationalPhone(d.customer_phone);
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push({ ...d, t: Date.parse(String(d.created_at).replace(' ', 'T') + (/[zZ+]/.test(String(d.created_at).slice(10)) ? '' : 'Z')) });
  }
  const used = new Set();
  const summary = { checked: shopOrders.length, changed: 0, unmatched: [], unknown: [] };
  for (const o of shopOrders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const p = nationalPhone(o.phone);
    const t0 = new Date(o.createdAt).getTime();
    // ventana amplia: Dropi guarda la hora sin zona horaria
    const cands = (byPhone.get(p) || []).filter((d) => !used.has(d.order_id) && d.t >= t0 - 5 * 3600e3 && d.t <= t0 + 75 * 3600e3);
    const alive = cands.filter((d) => !DEAD.has(norm(d.status)));
    const pool = alive.length ? alive : cands;
    const match = pool.sort((a, b) => Math.abs(a.t - t0) - Math.abs(b.t - t0))[0];
    if (!match) { summary.unmatched.push(o.name); continue; }
    used.add(match.order_id);
    const tag = shipTagFor(match.status);
    if (tag === undefined) { summary.unknown.push(`${o.name} (${match.status})`); continue; }
    if (tag !== 'none') {
      const current = (o.tags || []).filter((x) => /^ENVIO-/i.test(x));
      if (!(current.length === 1 && current[0].toUpperCase() === tag)) {
        const line = `Envío Dropi: ${match.status} (${cap(match.shipping_company)}, ${match.tracking_code ? `seguimiento ${match.tracking_code}` : 'sin seguimiento'}), actualizado ${chileNow()}`;
        const note = upsertNoteLine(o.note, 'Envío Dropi:', line);
        try {
          if (current.length) await shopify.removeTags(o.id, current);
          await shopify.addTags(o.id, [tag]);
          await shopify.setNote(o.id, note);
          o.tags = [...(o.tags || []).filter((x) => !/^ENVIO-/i.test(x)), tag];
          o.note = note;
          summary.changed++;
          db.logEvent(null, null, 'dropi_shipping', `${o.name}: ${match.status}`);
          console.log('[dropi envío]', o.name, match.status, '→', tag);
        } catch (e) { console.error('[dropi envío] Shopify', o.name, e.message); continue; }
      }
    }
    // El pedido puede ser más antiguo que la ventana de sincronización: se actualiza aquí directo
    const s = parseShipping(o.tags, o.note);
    if (s.status && db.getOrder(o.id)) updateShipping(o.id, s);
  }
  db.setSetting('dropi_ship_last', JSON.stringify({ at: db.now(), ...summary }));
  if (summary.unknown.length) console.warn('[dropi envío] estados desconocidos:', summary.unknown.join(', '));
  return summary;
}
