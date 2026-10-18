// Audios de las clientas: se descargan, se guardan para escucharlos en el panel y se transcriben con OpenAI
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, whatsappReady } from './config.js';
import { downloadMedia } from './whatsapp.js';

export const MEDIA_DIR = path.join(config.dataDir, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf' };
export const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

// Guarda un archivo en el volumen y devuelve su nombre
export function saveMedia(buffer, mime) {
  const type = String(mime || '').split(';')[0];
  const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[type] || 'bin'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return file;
}

// Imágenes, videos y documentos recibidos: solo se guardan para verlos en el panel
export async function processFile(mediaId, mime) {
  if (!mediaId || !whatsappReady()) return { error: 'sin acceso a WhatsApp' };
  try {
    const { buffer, mime: realMime } = await downloadMedia(mediaId);
    return { file: saveMedia(buffer, realMime || mime) };
  } catch (e) {
    console.error('[archivo]', e.message);
    return { error: e.message };
  }
}

async function transcribe(buffer, mime, filename) {
  if (!config.ai.openaiKey) return null;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', config.ai.transcribeModel);
  form.append('language', 'es');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.ai.openaiKey}` }, body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Transcripción: ${data?.error?.message || res.status}`);
  return String(data.text || '').trim();
}

// Devuelve { file, transcript, error }
export async function processAudio(mediaId, mime) {
  if (!mediaId || !whatsappReady()) return { error: 'sin acceso a WhatsApp' };
  try {
    const { buffer, mime: realMime } = await downloadMedia(mediaId);
    const type = (realMime || mime || 'audio/ogg').split(';')[0];
    const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[type] || 'ogg'}`;
    fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
    let transcript = null, error = null;
    try { transcript = await transcribe(buffer, type, file); } catch (e) { error = e.message; console.error('[audio]', e.message); }
    return { file, mime: type, transcript, error };
  } catch (e) {
    console.error('[audio]', e.message);
    return { error: e.message };
  }
}

export function mediaPath(file) {
  if (!/^[\w.-]+$/.test(file)) return null;
  const p = path.join(MEDIA_DIR, file);
  return fs.existsSync(p) ? p : null;
}
