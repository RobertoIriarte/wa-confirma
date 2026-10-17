// Servidor HTTP: webhook de WhatsApp + API y archivos del panel
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, whatsappReady, shopifyReady, aiReady, aiModelName } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import * as shopify from './shopify.js';
import { handleInbound, orderSummaryButtons, requestPrepay } from './agent.js';
import { applyStatus, clearReview, flagForReview } from './orders.js';
import * as reminders from './reminders.js';
import { mediaPath } from './media.js';
import { ensureAddressChecked, addressDetail } from './address.js';

// Veredicto para confirmar en Dropi, con sus razones
function dropiVerdict(o, waId, allOrders) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  if (o.status === 'confirmed') add(true, o.resolved_by === 'human' ? 'Confirmado por el equipo' : 'La clienta confirmó por WhatsApp');
  else if (o.status === 'cancelled') add(false, 'La clienta canceló por WhatsApp');
  else add(null, 'La clienta aún no confirma');
  const d = addressDetail(o);
  if (o.addr_status === 'ok') add(true, 'Dirección encontrada en Google Maps');
  else if (o.addr_status === 'dudosa' || o.addr_status === 'no_encontrada') add(false, `Dirección ${o.addr_status === 'dudosa' ? 'dudosa' : 'no encontrada'}: ${(d.reasons || []).join('; ')}`);
  else add(null, `Dirección sin validar${d.reasons?.length ? ` (${d.reasons.join('; ')})` : ''}`);
  const minRate = config.history.minRate;
  if (o.hist_status === 'ok') add(true, `Historial ${o.hist_rate != null ? `${o.hist_rate}% positivo` : 'positivo'} en Dropi`);
  else if (o.hist_status === 'sin_registro') add(true, 'Sin historial en Dropi (clienta nueva, pasa)');
  else if (o.hist_status === 'bajo' && o.prepaid_at) add(true, config.history.lowAction === 'prepay' ? `Historial ${o.hist_rate ?? '?'}% (bajo ${minRate}%), pero pagó por adelantado` : `Historial ${o.hist_rate ?? '?'}% (bajo ${minRate}%), despacho aprobado por el equipo`);
  else if (o.hist_status === 'bajo' && config.history.lowAction === 'prepay') add(false, `Historial ${o.hist_rate ?? '?'}% positivo, bajo el mínimo de ${minRate}%: ${o.prepay_requested_at ? 'se pidió transferencia, falta el comprobante' : o.prepay_error || 'hay que pedir transferencia'}`);
  else if (o.hist_status === 'bajo') add(false, `Historial ${o.hist_rate ?? '?'}% positivo, bajo el mínimo de ${minRate}%: decidir si se despacha (la clienta no fue avisada)`);
  else add(null, 'Historial en Dropi aún sin revisar (se revisa cada hora)');
  const same = shopify.samePhone(o.phone, waId);
  add(same ? true : null, same ? 'El WhatsApp coincide con el teléfono del pedido' : 'El WhatsApp no coincide con el teléfono del pedido');
  const week = Date.now() - 7 * 86400e3;
  const others = allOrders.filter((x) => x.id !== o.id && x.status !== 'cancelled' && new Date(x.linked_at) > week);
  if (others.length) add(false, `Tiene otro${others.length > 1 ? 's' : ''} ${others.length} pedido${others.length > 1 ? 's' : ''} abierto${others.length > 1 ? 's' : ''} esta semana (${others.map((x) => x.name).join(', ')})`);
  let verdict;
  if (o.status === 'cancelled') verdict = 'no_despachar';
  else if (config.history.lowAction === 'prepay' && o.hist_status === 'bajo' && !o.prepaid_at && checks.filter((c) => c.ok === false).length === 1) verdict = 'prepago';
  else if (o.hist_status === 'bajo' && !o.prepaid_at && checks.filter((c) => c.ok === false).length === 1) verdict = 'historial_bajo';
  else if (checks.some((c) => c.ok === false)) verdict = 'revisar';
  else if (o.status === 'confirmed' && !o.hist_status) verdict = 'historial';
  else if (o.status === 'confirmed') verdict = 'listo';
  else verdict = 'esperando';
  return { verdict, checks };
}

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// ---------- utilidades ----------
const send = (res, status, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const json = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

// ---------- sesión del panel ----------
const sign = (v) => crypto.createHmac('sha256', config.dashboard.sessionSecret).update(v).digest('base64url');
const makeSession = () => { const exp = String(Date.now() + 30 * 86400e3); return `${exp}.${sign(exp)}`; };
function authed(req) {
  if (!config.dashboard.password) return config.demo; // sin contraseña solo se permite en DEMO
  const c = Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
  const [exp, sig] = String(c.wa_session || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const loginAttempts = new Map();

// ---------- webhook de Meta ----------
async function webhook(req, res, url) {
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.whatsapp.verifyToken && config.whatsapp.verifyToken;
    return ok ? send(res, 200, url.searchParams.get('hub.challenge') || '') : send(res, 403, 'forbidden');
  }
  const raw = await readBody(req, 5e6);
  if (!wa.validSignature(raw, req.headers['x-hub-signature-256'])) return send(res, 401, 'bad signature');
  send(res, 200, 'ok'); // responder rápido; Meta reintenta si tardamos
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
  processWebhook(payload);
}

function processWebhook(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (config.whatsapp.phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== config.whatsapp.phoneNumberId) continue;
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const p = wa.parseInbound(m);
        handleInbound({ waId: m.from, name: names[m.from], waMessageId: m.id, ...p });
      }
      for (const s of v.statuses || []) {
        db.updateMessageStatus(s.id, s.status, s.errors?.[0]?.error_data?.details || s.errors?.[0]?.title);
      }
    }
  }
}

// ---------- API del panel ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const { password } = await json(req);
    const good = config.dashboard.password;
    const ok = good && typeof password === 'string' && password.length === good.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(good));
    if (!ok) { a.n++; loginAttempts.set(ip, a); return send(res, 401, { error: 'Contraseña incorrecta' }); }
    loginAttempts.delete(ip);
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `wa_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}` });
  }
  if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'wa_session=; Path=/; Max-Age=0' });
  if (p === '/api/health') return send(res, 200, { ok: true });

  if (!authed(req)) return send(res, 401, { error: 'login' });

  if (p === '/api/status') {
    let shop = null; try { shop = await shopify.ping(); } catch (e) { shop = { ok: false, reason: e.message }; }
    return send(res, 200, { store: config.store.name, demo: config.demo, whatsapp: whatsappReady(), shopify: shop, ai: aiReady(), aiName: aiModelName(), historyAction: config.history.lowAction, maps: Boolean(config.maps.apiKey), model: config.ai.model, autoCancel: config.shopify.autoCancel, hasPassword: Boolean(config.dashboard.password) });
  }
  let mm = p.match(/^\/api\/media\/([\w.-]+)$/);
  if (mm) {
    const file = mediaPath(mm[1]);
    if (!file) return send(res, 404, { error: 'No existe' });
    const ext = path.extname(file).slice(1);
    res.writeHead(200, { 'Content-Type': { ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr' }[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/api/conversations' && req.method === 'GET') {
    return send(res, 200, db.listConversations({ filter: url.searchParams.get('filter') || 'all', q: url.searchParams.get('q') || '' }));
  }
  if (p === '/api/metrics') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return send(res, 200, db.metrics(days));
  }

  let m = p.match(/^\/api\/conversations\/([^/]+)(?:\/(\w+))?$/);
  if (m) {
    const waId = decodeURIComponent(m[1]);
    const action = m[2];
    const contact = db.getContact(waId);
    if (!contact) return send(res, 404, { error: 'No existe' });
    if (!action && req.method === 'GET') {
      if (contact.unread) db.updateContact(waId, { unread: 0 });
      const windowOpen = contact.last_inbound_at ? Date.now() - new Date(contact.last_inbound_at) < 24 * 3600e3 : false;
      const orders = db.ordersFor(waId).map((o, _i, all) => ({ ...o, addr: addressDetail(o), dropi: dropiVerdict(o, waId, all) }));
      return send(res, 200, { contact: { ...contact, unread: 0 }, windowOpen, messages: db.getMessages(waId), orders });
    }
    if (action === 'send' && req.method === 'POST') {
      const { text } = await json(req);
      if (!text?.trim()) return send(res, 400, { error: 'Mensaje vacío' });
      // Al responder a mano, el bot se pausa para no pisar la conversación
      db.updateContact(waId, { bot_paused: 1, needs_human: 0 });
      const r = await wa.sendText(waId, text.trim(), 'human');
      return send(res, r.ok ? 200 : 502, r);
    }
    if (action === 'bot' && req.method === 'POST') {
      const { paused } = await json(req);
      db.updateContact(waId, { bot_paused: paused ? 1 : 0, needs_human: 0, human_reason: null });
      db.logEvent(waId, null, paused ? 'bot_paused' : 'bot_resumed', 'human');
      if (!paused) { const o = db.activeOrderFor(waId); if (o) await clearReview(o.id); }
      return send(res, 200, { ok: true });
    }
    if (action === 'resend' && req.method === 'POST') {
      const o = db.activeOrderFor(waId);
      if (!o) return send(res, 400, { error: 'Sin pedido vinculado' });
      const r = await orderSummaryButtons(waId, o);
      return send(res, r.ok ? 200 : 502, r);
    }
    if (action === 'delete' && req.method === 'POST') {
      const orderIds = db.deleteConversation(waId);
      // Quita las etiquetas del agente en Shopify para que el pedido vuelva a quedar como nuevo
      const T = config.shopify.tags;
      for (const id of orderIds) {
        try { await shopify.removeTags(id, [T.confirmed, T.cancelled, T.review, T.prepay]); } catch (e) { console.error('[shopify]', e.message); }
      }
      return send(res, 200, { ok: true, orders: orderIds.length });
    }
    if (action === 'link' && req.method === 'POST') {
      const { number } = await json(req);
      const o = await shopify.findOrderByNumber(number);
      if (!o) return send(res, 404, { error: `No encontré el pedido ${number}` });
      return send(res, 200, db.linkOrder(o, waId, true));
    }
  }

  // Pedidos que no enviaron el mensaje
  if (p === '/api/silent' && req.method === 'GET') {
    const showDismissed = url.searchParams.get('dismissed') === '1';
    const list = db.silentOrders({ olderThanMin: config.reminders.graceMinutes, includeDismissed: showDismissed })
      .filter((o) => showDismissed ? o.dismissed : true)
      .map((o) => ({ ...o, wa_id: reminders.toWaId(o.phone), admin_url: shopify.adminUrl(o.id) }));
    return send(res, 200, { orders: list, remindersEnabled: reminders.remindersEnabled(), template: config.reminders.template, afterMinutes: config.reminders.afterMinutes, graceMinutes: config.reminders.graceMinutes, lastSyncAt: db.getSetting('last_sync_at') });
  }
  if (p === '/api/silent/sync' && req.method === 'POST') {
    return send(res, 200, await reminders.syncOrders());
  }
  m = p.match(/^\/api\/silent\/(.+)\/(remind|dismiss)$/);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    if (m[2] === 'dismiss') {
      const { dismissed = true } = await json(req);
      db.updateShopOrder(id, { dismissed: dismissed ? 1 : 0 });
      return send(res, 200, { ok: true });
    }
    try { await reminders.sendReminder(id, { manual: true }); return send(res, 200, { ok: true, waId: reminders.toWaId(db.getShopOrder(id).phone) }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  m = p.match(/^\/api\/orders\/(.+)\/(prepaid|request-prepay)$/);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const o = db.getOrder(id);
    if (!o) return send(res, 404, { error: 'Pedido no encontrado' });
    if (m[2] === 'prepaid') {
      const { paid = true } = await json(req);
      db.updateOrder(id, { prepaid_at: paid ? db.now() : null });
      db.logEvent(o.wa_id, id, paid ? 'prepaid' : 'prepaid_undo', 'human');
      if (paid) db.updateContact(o.wa_id, { needs_human: 0 });
      // Sin mensajes a la clienta: solo se quita (o vuelve a poner) la etiqueta de revisión en Shopify
      if (paid) await clearReview(id); else await flagForReview(id);
      return send(res, 200, { ok: true });
    }
    db.updateOrder(id, { prepay_requested_at: null, prepay_error: null });
    const r = await requestPrepay(db.getOrder(id), 'human');
    return send(res, r.ok === false ? 400 : 200, r.ok === false ? { error: db.getOrder(id).prepay_error || r.error || 'No se pudo enviar' } : { ok: true });
  }

  m = p.match(/^\/api\/orders\/(.+)\/check-address$/);
  if (m && req.method === 'POST') {
    const o = db.getOrder(decodeURIComponent(m[1]));
    if (!o) return send(res, 404, { error: 'Pedido no encontrado' });
    const r = await ensureAddressChecked(o, true);
    return send(res, 200, { status: r.addr_status, detail: addressDetail(r) });
  }

  m = p.match(/^\/api\/orders\/(.+)\/status$/);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const { status, cancelInShopify, notify } = await json(req);
    if (!['confirmed', 'cancelled', 'pending'].includes(status)) return send(res, 400, { error: 'Estado inválido' });
    const r = await applyStatus(id, status, 'human', { cancelInShopify: Boolean(cancelInShopify), note: 'Cancelado desde el panel de WhatsApp' });
    if (notify && r.order?.wa_id) {
      const msg = status === 'confirmed' ? `¡Muchas gracias! 💗 Recibimos la confirmación de su pedido *${r.order.name}* ✅ Ahora lo preparamos para el despacho y le avisaremos cuando vaya en camino.`
        : status === 'cancelled' ? `Su pedido *${r.order.name}* fue cancelado. Si necesita algo más, escríbanos 🙌` : null;
      if (msg) await wa.sendText(r.order.wa_id, msg, 'human');
    }
    return send(res, 200, r);
  }

  // Simulador (solo en DEMO): permite probar el agente sin Meta
  if (p === '/api/simulate' && req.method === 'POST') {
    if (!config.demo) return send(res, 403, { error: 'Solo disponible con DEMO=true' });
    const { from, name, text, buttonId } = await json(req);
    if (!from) return send(res, 400, { error: 'Falta el número' });
    await handleInbound({ waId: String(from).replace(/\D/g, ''), name, waMessageId: `sim.in.${crypto.randomUUID()}`, kind: buttonId ? 'button' : 'text', text: text || '', buttonId });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- estáticos ----------
function serveStatic(req, res, url) {
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/webhook') return await webhook(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(config.port, () => {
  console.log(`WhatsApp Confirma escuchando en :${config.port}`);
  console.log(`  WhatsApp: ${whatsappReady() ? 'conectado' : 'SIMULADO'} | Shopify: ${shopifyReady() ? config.shopify.domain : config.demo ? 'pedidos demo' : 'sin configurar'} | IA: ${aiReady() ? aiModelName() : 'desactivada'}${config.demo ? ' | MODO DEMO' : ''}`);
  if (!config.dashboard.password && !config.demo) console.warn('  ⚠️  Falta DASHBOARD_PASSWORD: el panel no se puede abrir.');
  reminders.startScheduler();
});

// Apagado limpio (Railway envía SIGTERM al reemplazar el servidor)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`Recibido ${sig}: cerrando…`);
    server.close(() => { try { db.db.close(); } catch { /* ya cerrada */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
