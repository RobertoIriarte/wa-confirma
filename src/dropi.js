// Conexión directa con el conector oficial de Dropi (MCP en https://mcp.dropi.co/mcp).
// La dueña inicia sesión una vez desde el panel (OAuth con PKCE); el bot guarda el acceso y lo renueva solo.
// Luego llama las herramientas de Dropi sin IA de por medio (no gasta tokens).
import crypto from 'node:crypto';
import * as db from './db.js';

const MCP_URL = process.env.DROPI_MCP_URL || 'https://mcp.dropi.co/mcp';
const AUTH = {
  authorize: 'https://oauth.dropi.co/oauth/authorize',
  token: 'https://integrations.dropi.co/oauth/token',
  register: 'https://integrations.dropi.co/oauth/register',
};
const KEY = 'dropi_oauth';

const load = () => { try { return JSON.parse(db.getSetting(KEY) || '{}'); } catch { return {}; } };
const save = (o) => db.setSetting(KEY, JSON.stringify(o));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export const dropiConnected = () => Boolean(load().refresh_token || load().access_token);
export function dropiStatus() {
  const s = load();
  return { connected: dropiConnected(), since: s.connected_at || null, lastError: s.last_error || null, lastOkAt: s.last_ok_at || null };
}
export function disconnect() { const s = load(); save({ client_id: s.client_id, redirect_uri: s.redirect_uri }); session = null; }

// ---------- inicio de sesión (OAuth) ----------
const pending = new Map(); // state -> { verifier, redirectUri, at }

async function ensureClient(redirectUri) {
  const s = load();
  if (s.client_id && s.redirect_uri === redirectUri) return s.client_id;
  const r = await fetch(AUTH.register, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Bot de WhatsApp (wa-confirma)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.client_id) throw new Error(`Dropi no aceptó el registro del bot (${r.status} ${d.error_description || d.error || ''})`);
  save({ ...load(), client_id: d.client_id, redirect_uri: redirectUri });
  return d.client_id;
}

export async function startLogin(redirectUri) {
  const clientId = await ensureClient(redirectUri);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60e3) pending.delete(k);
  pending.set(state, { verifier, redirectUri, at: Date.now() });
  const u = new URL(AUTH.authorize);
  Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'mcp', state, code_challenge: challenge, code_challenge_method: 'S256', resource: MCP_URL })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

async function tokenRequest(params) {
  const r = await fetch(AUTH.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, resource: MCP_URL }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Dropi: ${d.error_description || d.error || r.status}`);
  return d;
}

const storeTokens = (d, extra = {}) => save({
  ...load(), ...extra,
  access_token: d.access_token,
  refresh_token: d.refresh_token || load().refresh_token,
  expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  last_error: null,
});

export async function finishLogin(code, state) {
  const p = pending.get(state);
  if (!p) throw new Error('El inicio de sesión expiró o no es válido. Vuelva a presionar "Conectar Dropi".');
  pending.delete(state);
  const d = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: load().client_id, code_verifier: p.verifier });
  storeTokens(d, { connected_at: db.now() });
  session = null;
  db.logEvent(null, null, 'dropi_connected', '');
}

let refreshing = null;
async function accessToken(force = false) {
  const s = load();
  if (!s.access_token && !s.refresh_token) throw new Error('Dropi no está conectado');
  if (!force && s.access_token && s.expires_at > Date.now() + 60e3) return s.access_token;
  if (!s.refresh_token) throw new Error('La sesión de Dropi venció: hay que volver a conectar');
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id })
    .then((d) => { storeTokens(d); return d.access_token; })
    .catch((e) => { save({ ...load(), last_error: `${e.message} (vuelva a conectar Dropi)` }); throw e; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- llamadas al conector (JSON-RPC sobre HTTP) ----------
let session = null; // { id }
let seq = 0;

function parseBody(text, ctype, id) {
  if (/text\/event-stream/.test(ctype || '')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m.id === id) return m; } catch { /* sigue */ }
    }
    return null;
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(method, params, { notify = false, retried = false } = {}) {
  const id = notify ? undefined : ++seq;
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (session?.id) headers['Mcp-Session-Id'] = session.id;
  const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, params }), signal: AbortSignal.timeout(45000) });
  if (r.status === 401 && !retried) { await accessToken(true); return rpc(method, params, { notify, retried: true }); }
  if (r.status === 404 && session?.id && !retried && method !== 'initialize') { session = null; await init(); return rpc(method, params, { notify, retried: true }); }
  const sid = r.headers.get('mcp-session-id');
  if (sid && method === 'initialize') session = { id: sid };
  const text = await r.text();
  if (notify) return null;
  if (!r.ok) throw new Error(`Dropi ${r.status}: ${text.slice(0, 200)}`);
  const m = parseBody(text, r.headers.get('content-type'), id);
  if (!m) throw new Error('Dropi respondió vacío');
  if (m.error) throw new Error(`Dropi: ${m.error.message || JSON.stringify(m.error)}`);
  return m.result;
}

async function init() {
  if (session) return;
  session = {};
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wa-confirma', version: '1.0.0' } });
    await rpc('notifications/initialized', {}, { notify: true });
  } catch (e) { session = null; throw e; }
}

export async function callTool(name, args = {}) {
  try {
    await init();
    const res = await rpc('tools/call', { name, arguments: args });
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new Error(text || 'error de Dropi');
    save({ ...load(), last_ok_at: db.now(), last_error: null });
    return { data: res.structuredContent ?? null, text };
  } catch (e) {
    save({ ...load(), last_error: e.message });
    throw e;
  }
}

// ---------- lectura de las respuestas (formato compacto de Dropi) ----------
// "clave: valor" por línea
export function parseKV(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// "items[2]{a,b,c}:" seguido de filas separadas por comas
export function parseItems(text) {
  const lines = String(text || '').split('\n');
  const h = lines.findIndex((l) => /^\s*items\[\d+\]\{.*\}:\s*$/.test(l));
  if (h < 0) return [];
  const fields = lines[h].match(/\{(.*)\}/)[1].split(',').map((s) => s.trim());
  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*count\s*:/i.test(l) || /^\s*\w+\[\d+\]/.test(l)) break;
    const vals = splitCsv(l.trim());
    rows.push(Object.fromEntries(fields.map((f, j) => [f, vals[j] ?? ''])));
  }
  return rows;
}

// ---------- herramientas que usa el bot ----------
export async function fingerprint(phone) {
  const { data, text } = await callTool('get_customer_fingerprint_profile', { phone });
  if (data && typeof data === 'object' && !Array.isArray(data)) return { notFound: false, ...data };
  if (/no se encontr/i.test(text)) return { notFound: true };
  const kv = parseKV(text);
  return {
    notFound: false,
    buyer_type: kv.buyer_type || '',
    risk_label: kv.risk_label || '',
    delivery_probability: Number(kv.delivery_probability || 0),
    return_probability: Number(kv.return_probability || 0),
  };
}

export async function listOrders({ from, until }) {
  const all = [];
  for (let start = 0; start < 2000; start += 100) {
    const { data, text } = await callTool('list_orders', { from, until, result_number: 100, start });
    const items = Array.isArray(data?.items) ? data.items : parseItems(text);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}
