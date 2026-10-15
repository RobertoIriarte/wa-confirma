// Cliente mínimo de la API oficial de WhatsApp Cloud (Meta)
import crypto from 'node:crypto';
import { config, whatsappReady } from './config.js';
import { saveMessage } from './db.js';

const api = () => `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}`;

async function post(payload) {
  if (!whatsappReady()) {
    // Modo prueba: no se envía nada a Meta
    console.log('[whatsapp:simulado]', JSON.stringify(payload));
    return { id: `sim.${crypto.randomUUID()}`, simulated: true };
  }
  const res = await fetch(`${api()}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error;
    const e = new Error(err?.error_data?.details || err?.message || `WhatsApp HTTP ${res.status}`);
    e.code = err?.code;
    throw e;
  }
  return { id: data.messages?.[0]?.id };
}

// Envía y registra en la base. sender: bot | ai | human
async function sendAndLog(to, payload, { sender, body, kind, meta }) {
  try {
    const r = await post({ to, ...payload });
    saveMessage({ waId: to, direction: 'out', sender, kind, body, meta, waMessageId: r.id, status: 'sent' });
    return { ok: true, id: r.id };
  } catch (e) {
    // 131047 = pasaron más de 24 h desde el último mensaje del cliente
    const reason = e.code === 131047 ? 'Fuera de la ventana de 24 h: el cliente debe escribir primero o hay que usar una plantilla.' : e.message;
    saveMessage({ waId: to, direction: 'out', sender, kind, body, meta: { ...(meta || {}), error: reason }, status: 'failed' });
    console.error('[whatsapp] error al enviar:', reason);
    return { ok: false, error: reason };
  }
}

export function sendText(to, text, sender = 'bot') {
  return sendAndLog(to, { type: 'text', text: { body: text, preview_url: false } }, { sender, body: text, kind: 'text' });
}

// Hasta 3 botones; el título de cada botón tiene máximo 20 caracteres
export function sendButtons(to, text, buttons, sender = 'bot') {
  const payload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  };
  return sendAndLog(to, payload, { sender, body: text, kind: 'buttons', meta: { buttons: buttons.map((b) => b.title) } });
}

/**
 * Envía una plantilla aprobada por Meta (necesario para escribir primero o pasadas 24 h).
 * bodyParams: valores para {{1}}, {{2}}, ... del cuerpo.
 * buttonPayloads: payload de cada botón de respuesta rápida, en orden.
 */
export function sendTemplate(to, { name, language, bodyParams = [], buttonPayloads = [], preview }, sender = 'bot') {
  const components = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t ?? '') })) });
  buttonPayloads.forEach((payload, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }));
  const payload = { type: 'template', template: { name, language: { code: language }, components } };
  return sendAndLog(to, payload, { sender, body: preview || `[Plantilla ${name}]`, kind: 'template', meta: { template: name } });
}

export async function markRead(messageId) {
  if (!whatsappReady() || !messageId) return;
  try { await post({ status: 'read', message_id: messageId }); } catch { /* no es crítico */ }
}

// Verifica que el webhook venga de Meta (cabecera X-Hub-Signature-256)
export function validSignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return true; // sin secreto configurado no se puede validar
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Convierte un mensaje entrante de Meta en algo simple
export function parseInbound(m) {
  switch (m.type) {
    case 'text': return { kind: 'text', text: m.text?.body || '' };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      return { kind: 'button', text: r?.title || '', buttonId: r?.id };
    }
    case 'button': return { kind: 'button', text: m.button?.text || '', buttonId: m.button?.payload };
    case 'image': return { kind: 'image', text: m.image?.caption ? `[Imagen] ${m.image.caption}` : '[Imagen]' };
    case 'audio': return { kind: 'audio', text: '[Audio]' };
    case 'video': return { kind: 'video', text: '[Video]' };
    case 'document': return { kind: 'document', text: `[Documento] ${m.document?.filename || ''}`.trim() };
    case 'location': {
      const l = m.location || {};
      const label = [l.name, l.address].filter(Boolean).join(', ');
      return { kind: 'location', text: `📍 Ubicación enviada${label ? `: ${label}` : ''}\nhttps://www.google.com/maps?q=${l.latitude},${l.longitude}` };
    }
    case 'sticker': return { kind: 'sticker', text: '[Sticker]' };
    case 'reaction': return { kind: 'reaction', text: `[Reacción ${m.reaction?.emoji || ''}]` };
    case 'unsupported': return { kind: 'unsupported', text: '[Mensaje no soportado por WhatsApp Cloud]' };
    default: return { kind: 'unknown', text: `[${m.type || 'mensaje'} no soportado]` };
  }
}
