// El agente: decide qué responder a cada mensaje entrante
import { config, aiReady } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import * as shopify from './shopify.js';
import { applyStatus, flagForReview, money } from './orders.js';
import { ensureAddressChecked, addressDetail } from './address.js';

const STORE = () => config.store.name;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// ---------- textos ----------
// ¿El WhatsApp que escribe es el mismo teléfono del pedido? Si no, no mostramos datos personales.
export const verified = (o, waId) => shopify.samePhone(o?.phone, waId);

function orderSummary(o, waId) {
  if (!verified(o, waId)) {
    return [
      `¡Hola! 👋 Encontré el pedido *${o.name}* en ${STORE()}${o.total ? ` por ${money(o.total, o.currency)}` : ''}.`,
      'Por seguridad no mostramos los datos de despacho porque este WhatsApp no es el teléfono registrado en la compra.',
      '',
      '¿Confirmas el pedido?',
    ].join('\n');
  }
  const lines = [
    `¡Hola${firstName(o.customer_name) ? ' ' + firstName(o.customer_name) : ''}! 👋 Gracias por tu compra en ${STORE()}.`,
    '',
    `Este es tu pedido *${o.name}*:`,
    o.items ? `🛍️ ${o.items}` : null,
    o.address ? `📍 ${o.address}` : null,
    o.total ? `💰 Total: ${money(o.total, o.currency)}` : null,
    '',
    '¿Confirmas el pedido para despacharlo?',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
const confirmButtons = (o) => [
  { id: `confirm:${o.id}`, title: '✅ Confirmar' },
  { id: `cancel_ask:${o.id}`, title: '❌ Cancelar' },
  { id: `human:${o.id}`, title: '💬 Hablar con alguien' },
];

async function sendSummary(waId, order, sender = 'bot') {
  return wa.sendButtons(waId, orderSummary(order, waId), confirmButtons(order), sender);
}
export const orderSummaryButtons = (waId, order) => sendSummary(waId, order, 'human');

async function confirm(waId, order, by) {
  if (order.status === 'confirmed') return wa.sendText(waId, `Tu pedido ${order.name} ya estaba confirmado ✅ Te avisaremos cuando sea despachado.`, by);
  if (order.status === 'cancelled') return wa.sendText(waId, `Tu pedido ${order.name} figura como cancelado. Si quieres retomarlo, escríbenos y una persona del equipo te ayuda.`, by);
  if (by !== 'human' && await addressGate(waId, order, firstName(order.customer_name))) return;
  await applyStatus(order.id, 'confirmed', by);
  if (needsPrepay(db.getOrder(order.id))) return requestPrepay(order, by);
  return wa.sendText(waId, `¡Listo! Tu pedido *${order.name}* quedó confirmado ✅\nTe avisaremos cuando sea despachado. ¡Gracias por comprar en ${STORE()}! 💛`, by);
}

async function cancel(waId, order, by, reason) {
  if (order.status === 'cancelled') return wa.sendText(waId, `Tu pedido ${order.name} ya estaba cancelado.`, by);
  if (!verified(order, waId)) return handoff(waId, order, `Pide cancelar ${order.name} desde un número distinto al del pedido`, by);
  await applyStatus(order.id, 'cancelled', by, { note: reason ? `Cliente (WhatsApp): ${reason}` : undefined });
  return wa.sendText(waId, `Tu pedido *${order.name}* fue cancelado. Si fue un error o quieres cambiar algo, escríbenos y te ayudamos 🙌`, by);
}

async function handoff(waId, order, reason, by = 'bot', text) {
  db.updateContact(waId, { needs_human: 1, bot_paused: 1, human_reason: reason || 'El cliente pidió hablar con una persona' });
  db.logEvent(waId, order?.id, 'handoff', reason);
  if (order) await flagForReview(order.id);
  return wa.sendText(waId, text || 'Te comunico con una persona de nuestro equipo 🙋‍♀️ Te responderemos lo antes posible.', by);
}

// ---------- historial bajo: pago por adelantado ----------
const within24h = (iso) => iso && Date.now() - new Date(iso) < 23.5 * 3600e3;

export async function requestPrepay(order, by = 'bot') {
  const o = db.getOrder(order.id);
  if (!o?.wa_id || o.prepay_requested_at || o.prepaid_at || o.status === 'cancelled') return { skipped: true };
  const contact = db.getContact(o.wa_id);
  const reason = `Historial ${o.hist_rate != null ? `${o.hist_rate}% positivo` : 'bajo'} (mínimo ${config.history.minRate}%): se pidió pago por transferencia; verificar comprobante`;
  try { await shopify.addTags(o.id, [config.shopify.tags.prepay]); } catch (e) { console.error('[shopify]', e.message); }
  if (!within24h(contact?.last_inbound_at)) {
    db.updateOrder(o.id, { prepay_error: 'Pasaron más de 24 h desde su último mensaje: hay que llamarla o esperar que escriba' });
    db.updateContact(o.wa_id, { needs_human: 1, human_reason: `Historial bajo (${o.hist_rate ?? '?'}%): pedir transferencia por teléfono` });
    return { ok: false };
  }
  const who = firstName(o.customer_name);
  const text = [
    `Hola${who ? ' ' + who : ''} 💗 Para despachar tu pedido *${o.name}*${o.total ? ` (${money(o.total, o.currency)})` : ''} necesitamos que esta vez el pago sea por transferencia antes del envío.`,
    '',
    config.history.prepayInfo || 'En un momento te enviamos los datos para transferir.',
    '',
    'Cuando transfieras, envíanos el comprobante por aquí y te confirmamos el despacho 🙌',
  ].join('\n');
  const r = await wa.sendText(o.wa_id, text, by);
  db.updateOrder(o.id, r.ok ? { prepay_requested_at: db.now(), prepay_error: null } : { prepay_error: r.error });
  db.updateContact(o.wa_id, { needs_human: 1, bot_paused: 1, human_reason: reason });
  db.logEvent(o.wa_id, o.id, 'prepay_requested', r.ok ? 'ok' : r.error);
  return r;
}

// Después de confirmar: si el historial es bajo, se pide transferencia en vez del mensaje de cierre
const needsPrepay = (o) => o?.hist_status === 'bajo' && !o.prepaid_at;

// ---------- validación de dirección ----------
// Si Google Maps no encontró la dirección (o es dudosa), no se confirma: se pide la ubicación y se deriva.
async function addressGate(waId, order, who) {
  if (!config.maps.blockOnDoubt) return false;
  let o = order;
  try { o = await ensureAddressChecked(order); } catch (e) { console.error('[maps]', e.message); return false; }
  if (!['dudosa', 'no_encontrada'].includes(o.addr_status)) return false;
  const d = addressDetail(o);
  const where = [o.street, o.city].filter(Boolean).join(', ') || o.address;
  await handoff(waId, o, `Dirección ${o.addr_status === 'dudosa' ? 'dudosa' : 'no encontrada'} en Google Maps: ${(d.reasons || []).join('; ')}`, 'bot',
    `¡Gracias${who ? ' ' + who : ''}! 💗 Antes de confirmar tu pedido *${o.name}* queremos asegurarnos de que llegue sin problemas: no logramos ubicar en el mapa la dirección *${where}*.\n\n¿Nos envías tu ubicación 📍 (📎 › Ubicación) o la dirección completa con calle, número y comuna? Una persona del equipo la revisará y confirmará tu pedido.`);
  return true;
}

// ---------- mensaje de confirmación de Releasit ----------
// Ej: "Quiero confirmar mi pedido... Pedido: #1018 ... Total: $32.990 ... 📍 Playa Blanca 25, MEJILLONES, Antofagasta ... ✅ Confirmo mi pedido"
const CONFIRM_PATTERN = new RegExp(process.env.CONFIRM_PATTERN || 'confirmo mi pedido', 'i');
const AUTO_CONFIRM = !/^(0|false|no)$/i.test(process.env.CONFIRM_ON_FIRST_MESSAGE || 'true');
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseOrderMessage(text) {
  const t = String(text || '').replace(/[*_~]/g, '');
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const total = t.match(/total\s*:?\s*\$?\s*([\d.,]+)/i)?.[1];
  const addrLine = lines.find((l) => l.startsWith('📍')) || lines.find((l) => /^(direcci[oó]n|despacho)\s*:/i.test(l));
  return {
    isConfirmation: CONFIRM_PATTERN.test(t),
    name: t.match(/soy\s+([^\s.,!]+)/i)?.[1] || null,
    number: extractOrderNumber(t),
    total: total ? total.replace(/[.,]\d{1,2}$/, '').replace(/\D/g, '') : null,
    address: addrLine ? addrLine.replace(/^📍\s*/, '').replace(/^(direcci[oó]n|despacho)\s*:\s*/i, '') : null,
  };
}

// Compara lo que dice el mensaje con el pedido real. Devuelve las diferencias (vacío = todo coincide).
export function messageDifferences(parsed, order) {
  const diffs = [];
  const orderTotal = Number.isFinite(Number(order.total)) ? String(Math.round(Number(order.total))) : null;
  if (parsed.total && orderTotal && parsed.total !== orderTotal) {
    diffs.push(`total del mensaje ${money(parsed.total, order.currency)} y del pedido ${money(order.total, order.currency)}`);
  }
  if (parsed.address && order.address) {
    const have = new Set(norm(order.address).split(' '));
    const missing = norm(parsed.address).split(' ').filter((w) => w.length > 1 && !have.has(w));
    if (missing.length) diffs.push(`dirección del mensaje "${parsed.address}" y del pedido "${order.address}"`);
  }
  return diffs;
}

async function confirmFromMessage(waId, order, parsed) {
  const who = parsed.name || firstName(order.customer_name);
  if (order.status === 'confirmed') return wa.sendText(waId, `¡Hola${who ? ' ' + who : ''}! Tu pedido *${order.name}* ya estaba confirmado ✅ Te avisaremos cuando sea despachado.`);
  if (order.status === 'cancelled') return handoff(waId, order, `Quiere confirmar ${order.name}, que figura cancelado`, 'bot',
    `¡Hola${who ? ' ' + who : ''}! Tu pedido *${order.name}* figura como cancelado. Una persona del equipo te escribirá para revisarlo 🙌`);
  const diffs = messageDifferences(parsed, order);
  if (diffs.length) {
    return handoff(waId, order, `El mensaje de confirmación no coincide con Shopify: ${diffs.join('; ')}`, 'bot',
      `¡Gracias${who ? ' ' + who : ''}! 💗 Recibimos tu pedido *${order.name}*. Vimos que los datos de tu mensaje no coinciden con los del pedido, así que una persona del equipo los revisará contigo antes de despacharlo 🙌`);
  }
  if (await addressGate(waId, order, who)) return;
  await applyStatus(order.id, 'confirmed', 'bot');
  if (needsPrepay(db.getOrder(order.id))) return requestPrepay(order, 'bot');
  return wa.sendText(waId, `¡Gracias${who ? ' ' + who : ''}! 💗 Tu pedido *${order.name}* quedó confirmado ✅\nTe avisaremos cuando sea despachado. Si necesitas cambiar algo, escríbenos por aquí.`);
}

// ---------- búsqueda de pedido ----------
export function extractOrderNumber(text) {
  const t = String(text || '');
  const m = t.match(/#\s?(\d{3,7})\b/) || t.match(/pedido\s*(?:n(?:[°º.]|ro\.?|úmero|umero)?\s*)?:?\s*(\d{3,7})\b/i) || t.match(/^\s*(\d{3,6})\s*$/);
  return m ? m[1] : null;
}

async function locateOnce(waId, num) {
  if (num) {
    const o = await shopify.findOrderByNumber(num);
    return o ? { order: o, by: 'number' } : { notFound: num };
  }
  const open = (await shopify.findRecentOrdersByPhone(waId)).filter((o) => !o.cancelled);
  return open.length ? { order: open[0], by: 'phone' } : {};
}

// El mensaje de WhatsApp puede llegar segundos antes de que el pedido exista en Shopify
// (la clienta toca el botón apenas termina la compra). Si no aparece, reintenta un par de veces.
async function locateOrder(waId, text) {
  const num = extractOrderNumber(text);
  let found = await locateOnce(waId, num);
  for (const secs of config.shopify.retrySeconds) {
    if (found.order) break;
    await new Promise((r) => setTimeout(r, secs * 1000));
    found = await locateOnce(waId, num);
  }
  return found;
}

// ---------- intención rápida (sin gastar IA) ----------
const YES = /^\s*(s[ií]+|sip|confirmo|confirmado|confirmar|si,? confirmo|ok|okay|dale|listo|de acuerdo|perfecto)[\s!.,👍✅🙌]*$/i;

// ---------- punto de entrada ----------
const queues = new Map();
export function handleInbound(evt) {
  // Procesa los mensajes de cada cliente en orden, uno a la vez
  const prev = queues.get(evt.waId) || Promise.resolve();
  const next = prev.then(() => processInbound(evt)).catch((e) => console.error('[agent]', e));
  queues.set(evt.waId, next);
  next.finally(() => { if (queues.get(evt.waId) === next) queues.delete(evt.waId); });
  return next;
}

async function processInbound({ waId, name, waMessageId, kind, text, buttonId }) {
  if (waMessageId && db.messageExists(waMessageId)) return; // duplicado
  db.upsertContact(waId, name);
  db.saveMessage({ waId, direction: 'in', sender: 'customer', kind, body: text, waMessageId, meta: buttonId ? { buttonId } : null });
  wa.markRead(waMessageId);

  const contact = db.getContact(waId);
  if (contact.bot_paused) return; // lo está atendiendo una persona
  if (['reaction', 'sticker', 'unsupported', 'edit', 'unknown', 'system'].includes(kind)) return; // no requieren respuesta

  let order = db.activeOrderFor(waId);

  // 1) Botones
  if (buttonId) {
    const [action, orderId] = buttonId.split(/:(.+)/);
    const target = (orderId && db.getOrder(orderId)) || order;
    if (target) {
      if (action === 'confirm') return confirm(waId, target, 'bot');
      if (action === 'cancel_ask') {
        if (target.status === 'cancelled') return wa.sendText(waId, `Tu pedido ${target.name} ya estaba cancelado.`);
        return wa.sendButtons(waId, `¿Seguro que quieres cancelar el pedido ${target.name}?`, [
          { id: `cancel_yes:${target.id}`, title: 'Sí, cancelar' },
          { id: `keep:${target.id}`, title: 'No, lo mantengo' },
        ]);
      }
      if (action === 'cancel_yes') return cancel(waId, target, 'bot');
      if (action === 'keep') return confirm(waId, target, 'bot');
      if (action === 'human') return handoff(waId, target, 'El cliente pidió hablar con una persona');
    }
  }

  // 2) Buscar el pedido si todavía no lo tenemos vinculado (o si menciona otro número de pedido)
  const parsed = parseOrderMessage(text);
  if (!order || (parsed.number && shopify.digits(order.name) !== parsed.number)) {
    let found = {};
    try { found = await locateOrder(waId, text); } catch (e) { console.error('[shopify]', e.message); }
    if (found.order) {
      order = db.linkOrder(found.order, waId, verified(found.order, waId));
      if (order.wa_id !== waId) return handoff(waId, null, `Menciona el pedido ${order.name}, que ya está en otra conversación`);
      try { order = await ensureAddressChecked(order); } catch (e) { console.error('[maps]', e.message); }
      if (AUTO_CONFIRM && parsed.isConfirmation) return confirmFromMessage(waId, order, parsed);
      if (order.status === 'cancelled') return aiOrFallback(waId, order);
      return sendSummary(waId, order);
    }
    if (order) return aiOrFallback(waId, order, found.notFound); // ya tenía otro pedido vinculado
    if (found.notFound && !aiReady()) {
      return wa.sendText(waId, `No encontré el pedido #${found.notFound} 🤔 ¿Puedes revisar el número en el correo de confirmación? Si prefieres, escribe "ayuda" y te atiende una persona.`);
    }
    return aiOrFallback(waId, null, found.notFound);
  }

  // 3) Mensaje de confirmación (Releasit) o respuesta simple tipo "sí"/"confirmo"
  if (AUTO_CONFIRM && parsed.isConfirmation && parsed.number) return confirmFromMessage(waId, order, parsed);
  if (order.status === 'pending' && YES.test(text)) return confirm(waId, order, 'bot');

  // 4) Todo lo demás: IA (o respuesta fija si no hay IA)
  return aiOrFallback(waId, order);
}

async function aiOrFallback(waId, order, notFoundNumber) {
  if (aiReady()) {
    try { return await runAI(waId, order, notFoundNumber); }
    catch (e) { console.error('[ai]', e.message); db.logEvent(waId, order?.id, 'ai_error', e.message); }
  }
  // Sin IA (o si falló)
  if (!order) {
    if (/ayuda|humano|persona|ejecutiv/i.test(lastInboundText(waId))) return handoff(waId, null, 'Pidió ayuda sin número de pedido');
    return wa.sendText(waId, `¡Hola! 👋 Soy el asistente de ${STORE()}. Para ayudarte, envíame tu número de pedido (por ejemplo: #1001). Lo encuentras en el correo de confirmación de compra.`);
  }
  if (order.status === 'pending') return sendSummary(waId, order);
  return handoff(waId, order, 'Mensaje que el bot no sabe responder');
}
const lastInboundText = (waId) => db.getMessages(waId, 1)[0]?.body || '';

// ---------- IA (Claude) ----------
const TOOLS = [
  { name: 'buscar_pedido', description: 'Busca un pedido de la tienda por su número (ej. 1001) y lo vincula a esta conversación. Úsalo cuando el cliente entregue su número de pedido.', input_schema: { type: 'object', properties: { numero: { type: 'string' } }, required: ['numero'] } },
  { name: 'mostrar_resumen_con_botones', description: 'Envía al cliente el resumen del pedido vinculado con los botones Confirmar / Cancelar / Hablar con alguien. Si lo usas, no repitas el resumen en tu respuesta.', input_schema: { type: 'object', properties: {} } },
  { name: 'confirmar_pedido', description: 'Marca el pedido vinculado como confirmado. Solo si el cliente expresó claramente que confirma. Envía automáticamente el mensaje de confirmación; no lo repitas.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancelar_pedido', description: 'Cancela el pedido vinculado. Solo si el cliente pidió explícitamente cancelar y lo ratificó. Envía automáticamente el aviso; no lo repitas.', input_schema: { type: 'object', properties: { motivo: { type: 'string' } } } },
  { name: 'derivar_a_humano', description: 'Pasa la conversación a una persona del equipo y pausa el bot. Úsalo para: cambios de dirección, productos o cantidades, reclamos, pagos, devoluciones, dudas que no puedes responder con la información disponible, o si el cliente lo pide. Envía automáticamente el aviso al cliente.', input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] } },
];

function systemPrompt(order, notFoundNumber, waIdForPrompt) {
  const o = order;
  return `Eres el asistente de WhatsApp de la tienda online "${STORE()}" (Chile). Atiendes a clientes que escriben para confirmar su compra.

Estilo: español de Chile, cercano y amable, tuteando. Mensajes cortos (1 a 3 frases), formato de WhatsApp (*negrita* con asteriscos, sin markdown de títulos). Emojis con moderación.

Tu objetivo principal es que el cliente confirme o cancele su pedido. Reglas:
- Nunca inventes plazos, precios, stock, políticas ni estados de envío. Si no está en la información de abajo, usa derivar_a_humano.
- No puedes modificar pedidos (dirección, productos, cantidades, pagos): para eso usa derivar_a_humano.
- Solo confirma o cancela cuando el cliente lo exprese claramente. Ante la duda, usa mostrar_resumen_con_botones.
- Si no hay pedido vinculado, pide el número de pedido (aparece en el correo de compra, ej. #1001) y usa buscar_pedido.
- Las herramientas confirmar_pedido, cancelar_pedido, derivar_a_humano y mostrar_resumen_con_botones ya envían su propio mensaje: después de usarlas responde con texto vacío salvo que haga falta agregar algo distinto.
- Si el cliente envía audio o imagen que no puedes ver, pídele amablemente que lo escriba.

Información de la tienda:
${config.store.info || '(sin información adicional)'}

${o && !verified(o, waIdForPrompt) ? `Pedido vinculado: ${o.name}, estado ${({ pending: 'pendiente de confirmar', confirmed: 'CONFIRMADO', cancelled: 'CANCELADO' })[o.status]}, total ${money(o.total, o.currency)}.
IMPORTANTE: este WhatsApp NO coincide con el teléfono del pedido. No reveles nombre, dirección ni productos; si pide cambios o cancelar, usa derivar_a_humano.` : o ? `Pedido vinculado a esta conversación:
- Número: ${o.name}
- Estado de confirmación: ${({ pending: 'pendiente de confirmar', confirmed: 'CONFIRMADO', cancelled: 'CANCELADO' })[o.status]}
- Cliente: ${o.customer_name || '-'}
- Productos: ${o.items || '-'}
- Dirección: ${o.address || '-'}
- Total: ${money(o.total, o.currency)}
- Dirección en Google Maps: ${({ ok: 'verificada', dudosa: 'DUDOSA', no_encontrada: 'NO ENCONTRADA', sin_validar: 'sin validar' })[o.addr_status] || 'sin validar'}${['dudosa', 'no_encontrada'].includes(o.addr_status) ? ' (si la clienta envía su ubicación o corrige la dirección, usa derivar_a_humano para que el equipo la revise)' : ''}` : `No hay pedido vinculado todavía.${notFoundNumber ? ` El cliente mencionó el número ${notFoundNumber}, pero no existe en la tienda.` : ''}`}

Fecha y hora actual: ${new Date().toLocaleString('es-CL', { timeZone: config.store.timezone })}.`;
}

function history(waId) {
  const msgs = db.getMessages(waId, config.ai.historyMessages);
  const out = [];
  for (const m of msgs) {
    if (m.status === 'failed') continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    let text = m.body || '';
    if (m.kind === 'buttons' && m.meta?.buttons) text += `\n[Botones: ${m.meta.buttons.join(' | ')}]`;
    if (m.sender === 'human') text = `[Respuesta de una persona del equipo] ${text}`;
    if (!text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ai.model, max_tokens: 600, system, tools: TOOLS, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude ${res.status}: ${data?.error?.message || ''}`);
  return data;
}

async function runAI(waId, order, notFoundNumber) {
  const messages = history(waId);
  if (!messages.length) return;
  let current = order;
  let ended = false; // una herramienta ya respondió y cerró el turno

  for (let step = 0; step < 4; step++) {
    const res = await callClaude(systemPrompt(current, notFoundNumber, waId), messages);
    const toolUses = res.content.filter((c) => c.type === 'tool_use');
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

    if (!toolUses.length || res.stop_reason !== 'tool_use') {
      if (text && !(ended && text.length < 3)) await wa.sendText(waId, text, 'ai');
      return;
    }

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const t of toolUses) {
      let out;
      try {
        out = await runTool(t.name, t.input || {}, waId, current);
        if (out.order) current = out.order;
        if (out.ended) ended = true;
      } catch (e) { out = { result: `Error: ${e.message}` }; }
      results.push({ type: 'tool_result', tool_use_id: t.id, content: out.result });
    }
    messages.push({ role: 'user', content: results });
    if (ended && toolUses.every((t) => t.name !== 'buscar_pedido')) {
      // Las acciones finales ya enviaron su mensaje: no hace falta otra vuelta
      return;
    }
  }
}

async function runTool(name, input, waId, order) {
  switch (name) {
    case 'buscar_pedido': {
      const o = await shopify.findOrderByNumber(input.numero);
      if (!o) return { result: `No existe ningún pedido con el número ${input.numero}.` };
      const linked = db.linkOrder(o, waId, verified(o, waId));
      if (linked.wa_id !== waId) return { result: `El pedido ${o.name} ya está vinculado a otro número. Usa derivar_a_humano.` };
      return { order: linked, result: `Pedido ${linked.name} encontrado y vinculado. Estado: ${linked.status}. Usa mostrar_resumen_con_botones para que el cliente confirme.` };
    }
    case 'mostrar_resumen_con_botones':
      if (!order) return { result: 'No hay pedido vinculado.' };
      await sendSummary(waId, order, 'ai');
      return { ended: true, result: 'Resumen enviado con botones.' };
    case 'confirmar_pedido':
      if (!order) return { result: 'No hay pedido vinculado.' };
      await confirm(waId, order, 'ai');
      return { ended: true, order: db.getOrder(order.id), result: 'Pedido confirmado y cliente avisado.' };
    case 'cancelar_pedido':
      if (!order) return { result: 'No hay pedido vinculado.' };
      await cancel(waId, order, 'ai', input.motivo);
      return { ended: true, order: db.getOrder(order.id), result: 'Pedido cancelado y cliente avisado.' };
    case 'derivar_a_humano':
      await handoff(waId, order, input.motivo, 'ai');
      return { ended: true, result: 'Derivado a una persona.' };
    default:
      return { result: 'Herramienta desconocida.' };
  }
}
