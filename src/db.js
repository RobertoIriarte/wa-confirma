import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'wa.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  wa_id TEXT PRIMARY KEY,
  name TEXT,
  bot_paused INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  human_reason TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL REFERENCES contacts(wa_id),
  direction TEXT NOT NULL,          -- in | out
  sender TEXT NOT NULL,             -- customer | bot | ai | human | system
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  meta TEXT,                        -- JSON (botones, errores...)
  wa_message_id TEXT UNIQUE,
  status TEXT,                      -- sent | delivered | read | failed
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_id, id);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,              -- gid de Shopify
  name TEXT NOT NULL,               -- #1001
  wa_id TEXT REFERENCES contacts(wa_id),
  customer_name TEXT,
  phone TEXT,
  total TEXT,
  currency TEXT,
  items TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled
  resolved_by TEXT,                 -- bot | ai | human
  order_created_at TEXT,
  linked_at TEXT NOT NULL,
  resolved_at TEXT,
  first_reply_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_wa ON orders(wa_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT, order_id TEXT, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
-- Todos los pedidos recientes de Shopify (para detectar los que nunca escribieron)
CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT, phone TEXT, total TEXT, currency TEXT, items TEXT, address TEXT,
  first_seen_at TEXT NOT NULL,
  reminder_status TEXT,             -- null | sent | failed | skipped
  reminder_at TEXT,
  reminder_error TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_created ON shop_orders(created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Columnas agregadas después de la primera versión (no falla si ya existen)
for (const [table, col, type] of [
  ['orders', 'street', 'TEXT'], ['orders', 'city', 'TEXT'], ['orders', 'province', 'TEXT'],
  ['orders', 'addr_status', 'TEXT'],   // ok | dudosa | no_encontrada | sin_validar
  ['orders', 'addr_detail', 'TEXT'],   // JSON con razones, dirección de Google y enlace al mapa
  ['orders', 'hist_status', 'TEXT'],   // ok | bajo | sin_registro | null (sin revisar)
  ['orders', 'hist_rate', 'INTEGER'],
  ['orders', 'hist_text', 'TEXT'],
  ['orders', 'prepay_requested_at', 'TEXT'],
  ['orders', 'prepay_error', 'TEXT'],
  ['orders', 'prepaid_at', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* ya existe */ }
}

export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
export const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

export const now = () => new Date().toISOString();

// ---------- contactos ----------
export function upsertContact(waId, name) {
  const t = now();
  db.prepare(`INSERT INTO contacts (wa_id, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(wa_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`).run(waId, name || null, t);
  return getContact(waId);
}
export const getContact = (waId) => db.prepare('SELECT * FROM contacts WHERE wa_id = ?').get(waId);
export function updateContact(waId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE wa_id = ?`).run(...keys.map((k) => fields[k]), waId);
}

// ---------- mensajes ----------
export function saveMessage({ waId, direction, sender, kind = 'text', body, meta, waMessageId, status }) {
  const t = now();
  try {
    const r = db.prepare(`INSERT INTO messages (wa_id, direction, sender, kind, body, meta, wa_message_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(waId, direction, sender, kind, body ?? null, meta ? JSON.stringify(meta) : null, waMessageId || null, status || null, t);
    const fields = { last_message_at: t };
    if (direction === 'in') Object.assign(fields, { last_inbound_at: t });
    updateContact(waId, fields);
    if (direction === 'in') db.prepare('UPDATE contacts SET unread = unread + 1 WHERE wa_id = ?').run(waId);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null; // duplicado (Meta reintenta webhooks)
    throw e;
  }
}
export const messageExists = (waMessageId) => Boolean(db.prepare('SELECT 1 FROM messages WHERE wa_message_id = ?').get(waMessageId));
export function updateMessageStatus(waMessageId, status, error) {
  const order = { sent: 1, delivered: 2, read: 3, failed: 4 };
  const row = db.prepare('SELECT id, status, meta FROM messages WHERE wa_message_id = ?').get(waMessageId);
  if (!row) return;
  if (row.status && order[row.status] >= order[status] && status !== 'failed') return;
  const meta = row.meta ? JSON.parse(row.meta) : {};
  if (error) meta.error = error;
  db.prepare('UPDATE messages SET status = ?, meta = ? WHERE id = ?').run(status, JSON.stringify(meta), row.id);
}
export const getMessages = (waId, limit = 300) =>
  db.prepare('SELECT * FROM (SELECT * FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(waId, limit)
    .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));

// ---------- pedidos ----------
// Vincula un pedido a una conversación. Si ya estaba en otra, solo se mueve cuando force=true
// (el teléfono de quien escribe coincide con el del pedido).
export function linkOrder(o, waId, force = false) {
  const t = now();
  const existing = getOrder(o.id);
  if (existing?.wa_id && existing.wa_id !== waId && !force) return existing;
  db.prepare(`INSERT INTO orders (id, name, wa_id, customer_name, phone, total, currency, items, address, street, city, province, order_created_at, linked_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET wa_id = excluded.wa_id, customer_name = excluded.customer_name, phone = excluded.phone,
      total = excluded.total, items = excluded.items, address = excluded.address,
      street = COALESCE(excluded.street, orders.street), city = COALESCE(excluded.city, orders.city), province = COALESCE(excluded.province, orders.province),
      addr_status = CASE WHEN excluded.address IS NOT orders.address THEN NULL ELSE orders.addr_status END`)
    .run(o.id, o.name, waId, o.customerName, o.phone, o.total, o.currency, o.items, o.address, o.street ?? null, o.city ?? null, o.province ?? null, o.createdAt, t, o.cancelled ? 'cancelled' : 'pending');
  if (o.history?.status) updateOrderHistory(o.id, o.history);
  logEvent(waId, o.id, 'order_linked', o.name);
  return getOrder(o.id);
}
// Guarda el historial; devuelve true si cambió
export function updateOrderHistory(id, h) {
  const cur = getOrder(id);
  if (!cur || !h?.status) return false;
  if (cur.hist_status === h.status && cur.hist_rate === (h.rate ?? null) && cur.hist_text === (h.text ?? null)) return false;
  db.prepare('UPDATE orders SET hist_status = ?, hist_rate = ?, hist_text = ? WHERE id = ?').run(h.status, h.rate ?? null, h.text ?? null, id);
  logEvent(cur.wa_id, id, 'history', `${h.status}${h.rate != null ? ` ${h.rate}%` : ''}`);
  return true;
}
export function updateOrder(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}
export function setAddressCheck(id, status, detail) {
  db.prepare('UPDATE orders SET addr_status = ?, addr_detail = ? WHERE id = ?').run(status, JSON.stringify(detail || {}), id);
}
export const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
export const ordersFor = (waId) => db.prepare('SELECT * FROM orders WHERE wa_id = ? ORDER BY linked_at DESC').all(waId);
export const activeOrderFor = (waId) =>
  db.prepare(`SELECT * FROM orders WHERE wa_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, linked_at DESC LIMIT 1`).get(waId);
export function setOrderStatus(id, status, by) {
  const t = now();
  db.prepare('UPDATE orders SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(status, status === 'pending' ? null : by, status === 'pending' ? null : t, id);
  const o = getOrder(id);
  logEvent(o?.wa_id, id, `order_${status}`, by);
  return o;
}
export function markFirstReply(waId) {
  db.prepare(`UPDATE orders SET first_reply_at = ? WHERE wa_id = ? AND first_reply_at IS NULL`).run(now(), waId);
}

export function logEvent(waId, orderId, type, detail) {
  db.prepare('INSERT INTO events (wa_id, order_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(waId || null, orderId || null, type, detail == null ? null : String(detail), now());
}

// ---------- pedidos de la tienda (sincronizados) ----------
export function upsertShopOrder(o) {
  db.prepare(`INSERT INTO shop_orders (id, name, created_at, cancelled, customer_name, phone, total, currency, items, address, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cancelled = excluded.cancelled, customer_name = excluded.customer_name, phone = excluded.phone,
      total = excluded.total, items = excluded.items, address = excluded.address`)
    .run(o.id, o.name, o.createdAt, o.cancelled ? 1 : 0, o.customerName, o.phone, o.total, o.currency, o.items, o.address, now());
}
export const getShopOrder = (id) => db.prepare('SELECT * FROM shop_orders WHERE id = ?').get(id);
export function updateShopOrder(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE shop_orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}
// Pedidos que no tienen conversación de WhatsApp vinculada
export function silentOrders({ olderThanMin = 0, includeDismissed = false } = {}) {
  const before = new Date(Date.now() - olderThanMin * 60e3).toISOString();
  return db.prepare(`SELECT s.* FROM shop_orders s
    WHERE s.cancelled = 0 AND s.created_at <= ? ${includeDismissed ? '' : 'AND s.dismissed = 0'}
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = s.id AND o.wa_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.wa_id = o.wa_id AND m.direction = 'in'))
    ORDER BY s.created_at DESC LIMIT 300`).all(before);
}

// ---------- bandeja ----------
export function listConversations({ filter = 'all', q = '' } = {}) {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT sender FROM messages m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_sender,
      o.id AS order_id, o.name AS order_name, o.status AS order_status, o.addr_status AS order_addr, o.hist_status AS order_hist, o.prepaid_at AS order_prepaid, o.total AS order_total, o.currency AS order_currency
    FROM contacts c
    LEFT JOIN orders o ON o.id = (
      SELECT id FROM orders WHERE wa_id = c.wa_id
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, linked_at DESC LIMIT 1)
    ORDER BY c.needs_human DESC, c.last_message_at DESC
    LIMIT 500`).all();
  const term = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'human' && !r.needs_human && !r.bot_paused) return false;
    if (['pending', 'confirmed', 'cancelled'].includes(filter) && r.order_status !== filter) return false;
    if (filter === 'no_order' && r.order_id) return false;
    if (filter === 'ready' && !(r.order_status === 'confirmed' && !r.needs_human && !['dudosa', 'no_encontrada'].includes(r.order_addr)
      && (r.order_hist === 'ok' || r.order_hist === 'sin_registro' || (r.order_hist === 'bajo' && r.order_prepaid)))) return false;
    if (filter === 'prepay' && !(r.order_hist === 'bajo' && !r.order_prepaid && r.order_status !== 'cancelled')) return false;
    if (filter === 'address' && !['dudosa', 'no_encontrada'].includes(r.order_addr)) return false;
    if (term && ![r.name, r.wa_id, r.order_name, r.last_body].some((v) => String(v || '').toLowerCase().includes(term))) return false;
    return true;
  });
}

// ---------- métricas ----------
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: config.store.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function metrics(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const orders = db.prepare('SELECT * FROM orders WHERE linked_at >= ?').all(since);
  const msgs = db.prepare('SELECT wa_id, direction, sender, created_at FROM messages WHERE created_at >= ? ORDER BY id').all(since);

  const by = (s) => orders.filter((o) => o.status === s).length;
  const confirmed = by('confirmed'), cancelled = by('cancelled'), pending = by('pending');
  const resolved = confirmed + cancelled;

  // Tiempo de respuesta: desde un mensaje entrante del cliente hasta la siguiente respuesta nuestra
  const waiting = new Map();
  const responseSecs = [];
  const humanSecs = [];
  for (const m of msgs) {
    if (m.direction === 'in') { if (!waiting.has(m.wa_id)) waiting.set(m.wa_id, m.created_at); continue; }
    const t0 = waiting.get(m.wa_id);
    if (t0) {
      const secs = (new Date(m.created_at) - new Date(t0)) / 1000;
      responseSecs.push(secs);
      if (m.sender === 'human') humanSecs.push(secs);
      waiting.delete(m.wa_id);
    }
  }

  // Serie diaria
  const series = {};
  for (let i = days - 1; i >= 0; i--) series[dayKey(new Date(Date.now() - i * 86400000).toISOString())] = { inbound: 0, outbound: 0, confirmed: 0, cancelled: 0, orders: 0 };
  for (const m of msgs) { const k = dayKey(m.created_at); if (series[k]) series[k][m.direction === 'in' ? 'inbound' : 'outbound']++; }
  for (const o of orders) {
    const k = dayKey(o.linked_at); if (series[k]) series[k].orders++;
    if (o.resolved_at) { const r = dayKey(o.resolved_at); if (series[r] && series[r][o.status] !== undefined) series[r][o.status]++; }
  }

  const outbound = msgs.filter((m) => m.direction === 'out');
  const auto = outbound.filter((m) => m.sender === 'bot' || m.sender === 'ai').length;
  const autoResolved = orders.filter((o) => o.resolved_by === 'bot' || o.resolved_by === 'ai').length;
  const totalAmount = (s) => orders.filter((o) => o.status === s).reduce((a, o) => a + (Number(o.total) || 0), 0);

  const shopTotal = db.prepare('SELECT COUNT(*) AS n FROM shop_orders WHERE created_at >= ? AND cancelled = 0').get(since).n;
  const grace = new Date(Date.now() - config.reminders.graceMinutes * 60e3).toISOString();
  const silent = db.prepare(`SELECT COUNT(*) AS n FROM shop_orders s WHERE s.created_at >= ? AND s.created_at <= ? AND s.cancelled = 0
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = s.id AND EXISTS (SELECT 1 FROM messages m WHERE m.wa_id = o.wa_id AND m.direction = 'in'))`).get(since, grace).n;
  const remindersSent = db.prepare("SELECT COUNT(*) AS n FROM shop_orders WHERE reminder_status = 'sent' AND reminder_at >= ?").get(since).n;

  return {
    days,
    shopOrders: shopTotal,
    silentOrders: silent,
    messageRate: shopTotal ? (shopTotal - silent) / shopTotal : null,
    remindersSent,
    orders: orders.length,
    confirmed, cancelled, pending,
    confirmationRate: resolved ? confirmed / resolved : null,
    responseRate: orders.length ? resolved / orders.length : null,
    confirmedAmount: totalAmount('confirmed'),
    cancelledAmount: totalAmount('cancelled'),
    currency: orders.find((o) => o.currency)?.currency || '',
    medianResponseSecs: median(responseSecs),
    medianHumanResponseSecs: median(humanSecs),
    medianTimeToConfirmMin: median(orders.filter((o) => o.resolved_at).map((o) => (new Date(o.resolved_at) - new Date(o.linked_at)) / 60000)),
    inbound: msgs.length - outbound.length,
    outbound: outbound.length,
    automationShare: outbound.length ? auto / outbound.length : null,
    autoResolvedShare: resolved ? autoResolved / resolved : null,
    conversations: new Set(msgs.map((m) => m.wa_id)).size,
    needsHuman: db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE needs_human = 1').get().n,
    series: Object.entries(series).map(([day, v]) => ({ day, ...v })),
  };
}
