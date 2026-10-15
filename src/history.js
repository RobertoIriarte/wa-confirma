// Historial de la clienta (entregas vs devoluciones en Dropi).
// Lo escribe en cada pedido de Shopify la revisión programada (etiqueta + nota); aquí solo se lee.
//
// Contrato con la revisión programada:
//   Etiquetas: HIST-OK | HIST-BAJO | HIST-SIN-REGISTRO
//   Nota:      "Historial Dropi: 85% positivo (entregas 80%, devoluciones 14%), revisado 13-10-2026 14:00"
//              "Historial Dropi: sin registro, revisado 13-10-2026 14:00"
import { config } from './config.js';

export const HISTORY_TAGS = { ok: 'HIST-OK', bajo: 'HIST-BAJO', sin_registro: 'HIST-SIN-REGISTRO' };

export function parseHistory(tags = [], note = '') {
  const t = new Set((tags || []).map((x) => String(x).toUpperCase()));
  const line = String(note || '').split('\n').find((l) => /historial dropi:/i.test(l)) || '';
  const rate = line.match(/(\d{1,3})\s*%\s*positivo/i)?.[1];
  let status = null;
  if (t.has(HISTORY_TAGS.bajo)) status = 'bajo';
  else if (t.has(HISTORY_TAGS.ok)) status = 'ok';
  else if (t.has(HISTORY_TAGS['sin_registro'])) status = 'sin_registro';
  // Si solo viene la nota, se decide con el umbral configurado
  if (!status && rate != null) status = Number(rate) >= config.history.minRate ? 'ok' : 'bajo';
  if (!status && /sin registro/i.test(line)) status = 'sin_registro';
  return { status, rate: rate != null ? Number(rate) : null, text: line.replace(/^.*?historial dropi:\s*/i, '').trim() || null };
}

// ¿Pasa la regla? Sin registro pasa; sin revisar todavía queda pendiente.
export const historyPasses = (status) => status === 'ok' || status === 'sin_registro';
