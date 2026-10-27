// Acceso a pedidos de Shopify (Admin GraphQL API)
import { config, shopifyReady } from './config.js';
import { parseHistory } from './history.js';
import { parseShipping } from './shipping.js';

let cachedToken = null; // { token, expiresAt }

// Apps creadas en el Dev Dashboard (desde 2026) usan client credentials: el token dura ~24 h y se renueva solo.
async function getToken() {
  if (config.shopify.accessToken) return config.shopify.accessToken;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(`https://${config.shopify.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Shopify token: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 86000) * 1000 };
  return cachedToken.token;
}

async function gql(query, variables = {}) {
  const res = await fetch(`https://${config.shopify.domain}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) cachedToken = null;
  if (!res.ok || data.errors) throw new Error(`Shopify: ${JSON.stringify(data.errors || res.status)}`);
  return data.data;
}

const ORDER_FIELDS = `id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus tags note phone email paymentGatewayNames
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { displayName defaultPhoneNumber { phoneNumber } }
  shippingAddress { name address1 address2 city province phone }
  lineItems(first: 10) { nodes { title quantity } }`;

const FIND = `query FindOrders($q: String!, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;

export const digits = (s) => String(s || '').replace(/\D/g, '');
// Compara teléfonos por los últimos 8 dígitos (tolera +56, 9, espacios, etc.)
export const samePhone = (a, b) => { const x = digits(a), y = digits(b); return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8); };

function mapOrder(n) {
  const a = n.shippingAddress || {};
  return {
    id: n.id,
    name: n.name,
    createdAt: n.createdAt,
    cancelled: Boolean(n.cancelledAt),
    financialStatus: n.displayFinancialStatus,
    fulfillmentStatus: n.displayFulfillmentStatus,
    tags: n.tags || [],
    customerName: a.name || n.customer?.displayName || '',
    phone: a.phone || n.phone || n.customer?.defaultPhoneNumber?.phoneNumber || '',
    total: n.totalPriceSet?.shopMoney?.amount,
    currency: n.totalPriceSet?.shopMoney?.currencyCode,
    items: (n.lineItems?.nodes || []).map((l) => `${l.quantity} x ${l.title}`).join(', '),
    address: [a.address1, a.address2, a.city, a.province].filter(Boolean).join(', '),
    street: [a.address1, a.address2].filter(Boolean).join(', '),
    city: a.city || '',
    province: a.province || '',
    gateways: n.paymentGatewayNames || [],
    note: n.note || '',
    history: parseHistory(n.tags, n.note),
    shipping: parseShipping(n.tags, n.note),
  };
}

// ---------------- Pedidos de ejemplo (modo DEMO) ----------------
const demoOrders = [
  { id: 'gid://shopify/Order/9001', name: '#1001', createdAt: new Date(Date.now() - 3600e3).toISOString(), cancelled: false, customerName: 'Camila Rojas', phone: '+56 9 8765 4321', total: '24990', currency: 'CLP', items: '1 x Sérum facial vitamina C, 1 x Crema hidratante', address: 'Av. Providencia 1234, depto 56, Providencia, Región Metropolitana', street: 'Av. Providencia 1234, depto 56', city: 'Providencia', province: 'Región Metropolitana', tags: ['HIST-OK'], history: { status: 'ok', rate: 92, text: '92% positivo (entregas 88%, devoluciones 8%)' } },
  { id: 'gid://shopify/Order/9002', name: '#1002', createdAt: new Date(Date.now() - 7200e3).toISOString(), cancelled: false, customerName: 'Javiera Muñoz', phone: '+56 9 1234 5678', total: '39980', currency: 'CLP', items: '2 x Perfume Essence 50 ml', address: 'Los Carrera 455, Concepción, Biobío', street: 'Los Carrera 455', city: 'Concepción', province: 'Biobío', tags: ['HIST-BAJO'], history: { status: 'bajo', rate: 55, text: '55% positivo (entregas 50%, devoluciones 41%)' } },
];

// Pedidos sin mensaje en modo demo
const demoSilent = [
  { id: 'gid://shopify/Order/9003', name: '#1003', createdAt: new Date(Date.now() - 50 * 60e3).toISOString(), cancelled: false, customerName: 'Fernanda Soto', phone: '+56 9 5555 0101', total: '19990', currency: 'CLP', items: '1 x Bruma corporal vainilla', address: 'Av. Libertad 880, Viña del Mar, Valparaíso', street: 'Av. Libertad 880', city: 'Viña del Mar', province: 'Valparaíso', tags: ['HIST-SIN-REGISTRO'], history: { status: 'sin_registro', rate: null, text: 'sin registro' } },
  { id: 'gid://shopify/Order/9004', name: '#1004', createdAt: new Date(Date.now() - 20 * 60e3).toISOString(), cancelled: false, customerName: 'Antonia Reyes', phone: '9 5555 0202', total: '44970', currency: 'CLP', items: '3 x Labial mate', address: 'Barros Arana 2210, La Serena, Coquimbo', street: 'Barros Arana 2210', city: 'La Serena', province: 'Coquimbo', tags: [] },
];

// ---------------- API pública ----------------
// Todos los pedidos creados en los últimos `days` días (para detectar los que no escribieron)
export async function listRecentOrders(days) {
  if (!shopifyReady()) return config.demo ? [...demoOrders, ...demoSilent] : [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const Q = `query Recent($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`;
  const out = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const d = await gql(Q, { q: `created_at:>='${since}'`, after });
    out.push(...d.orders.nodes.map(mapOrder));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

// Enlace al pedido en el admin de Shopify
export function adminUrl(id) {
  const handle = config.shopify.domain.replace(/\.myshopify\.com$/, '');
  const num = String(id).split('/').pop();
  return handle ? `https://admin.shopify.com/store/${handle}/orders/${num}` : null;
}

export async function findOrderByNumber(num) {
  const clean = String(num).replace(/\D/g, '');
  if (!clean) return null;
  if (!shopifyReady()) return config.demo ? [...demoOrders, ...demoSilent].find((o) => digits(o.name) === clean) || null : null;
  const d = await gql(FIND, { q: `name:#${clean}`, n: 3 });
  const n = d.orders.nodes.find((o) => digits(o.name) === clean);
  return n ? mapOrder(n) : null;
}

// Busca pedidos recientes y abiertos cuyo teléfono coincida con el de WhatsApp
export async function findRecentOrdersByPhone(waId) {
  if (!shopifyReady()) return config.demo ? [...demoOrders, ...demoSilent].filter((o) => samePhone(o.phone, waId)) : [];
  const since = new Date(Date.now() - config.shopify.lookbackDays * 86400000).toISOString();
  const d = await gql(FIND, { q: `status:open created_at:>='${since}'`, n: 100 });
  return d.orders.nodes.map(mapOrder).filter((o) => samePhone(o.phone, waId));
}

export async function addTags(id, tags) {
  if (!shopifyReady()) return { simulated: true };
  const d = await gql(`mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags });
  const errs = d.tagsAdd.userErrors; if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return { ok: true };
}

export async function removeTags(id, tags) {
  if (!shopifyReady()) return { simulated: true };
  const d = await gql(`mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags });
  const errs = d.tagsRemove.userErrors; if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return { ok: true };
}

// Cancela el pedido en Shopify (irreversible). Devuelve el stock y no notifica al cliente por correo.
export async function cancelOrder(id, note) {
  if (!shopifyReady()) return { simulated: true };
  const d = await gql(`mutation Cancel($id: ID!, $note: String) { orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: $note) { orderCancelUserErrors { field message code } job { id } } }`,
    { id, note: (note || 'Cancelado por el cliente vía WhatsApp').slice(0, 255) });
  const errs = d.orderCancel.orderCancelUserErrors; if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return { ok: true };
}

// Cambia la nota del pedido (el que llama ya armó la nota completa, respetando las otras líneas)
export async function setNote(id, note) {
  if (!shopifyReady()) return { simulated: true };
  const d = await gql(`mutation SetNote($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`, { input: { id, note } });
  const errs = d.orderUpdate.userErrors; if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return { ok: true };
}

// Pedidos abiertos de los últimos días cuyo envío todavía no termina
export async function listShippingCandidates(days = 10) {
  if (!shopifyReady()) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const d = await gql(FIND, { q: `created_at:>='${since}' status:open tag_not:ENVIO-ENTREGADO tag_not:ENVIO-DEVUELTO`, n: 100 });
  return d.orders.nodes.map(mapOrder);
}

export async function ping() {
  if (!shopifyReady()) return { ok: false, reason: config.demo ? 'demo' : 'sin configurar' };
  const d = await gql('{ shop { name } }');
  return { ok: true, shop: d.shop.name };
}
