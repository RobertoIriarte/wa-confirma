// Llena la base con conversaciones de ejemplo para ver el panel con datos (solo para probar).
// Uso: DATA_DIR=./data-demo node scripts/seed-demo.js
import { db } from '../src/db.js';

const names = ['Camila Rojas', 'Javiera Muñoz', 'Fernanda Soto', 'Valentina Díaz', 'Catalina Pérez', 'Constanza Vera', 'Daniela Fuentes', 'Francisca Lagos', 'Antonia Reyes', 'Ignacia Flores', 'Martina Castro', 'Josefa Navarro', 'Paula Herrera', 'Carolina Ortiz', 'Macarena Silva', 'Isidora Tapia', 'Trinidad Molina', 'Rocío Araya'];
const items = ['1 x Sérum facial vitamina C', '2 x Perfume Essence 50 ml', '1 x Crema hidratante, 1 x Tónico', '1 x Kit rutina noche', '1 x Bruma corporal vainilla', '3 x Labial mate'];
const cities = ['Providencia, Región Metropolitana', 'Ñuñoa, Región Metropolitana', 'Viña del Mar, Valparaíso', 'Concepción, Biobío', 'La Serena, Coquimbo', 'Temuco, Araucanía', 'Maipú, Región Metropolitana'];
let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const iso = (ms) => new Date(ms).toISOString();

db.exec('DELETE FROM events; DELETE FROM messages; DELETE FROM orders; DELETE FROM contacts; DELETE FROM shop_orders; DELETE FROM settings;');
const insC = db.prepare('INSERT INTO contacts (wa_id, name, bot_paused, needs_human, human_reason, unread, last_inbound_at, last_message_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
const insM = db.prepare('INSERT INTO messages (wa_id, direction, sender, kind, body, meta, status, created_at) VALUES (?,?,?,?,?,?,?,?)');
const insO = db.prepare('INSERT INTO orders (id, name, wa_id, customer_name, phone, total, currency, items, address, status, resolved_by, order_created_at, linked_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

const N = 46;
for (let i = 0; i < N; i++) {
  const name = names[i % names.length];
  const wa = `5699${String(1000000 + i * 7919).slice(-7)}`;
  const daysAgo = Math.floor(rnd() * 13);
  const t0 = Date.now() - daysAgo * 86400e3 - rnd() * 8 * 3600e3 - (i < 4 ? 0 : 1800e3);
  const r = rnd();
  const status = i < 3 || i === 5 ? 'pending' : r < 0.74 ? 'confirmed' : r < 0.9 ? 'cancelled' : 'pending';
  const by = rnd() < 0.82 ? (rnd() < 0.6 ? 'bot' : 'ai') : 'human';
  const total = [14990, 19990, 24990, 29990, 39980, 44970][Math.floor(rnd() * 6)];
  const num = 1180 + i;
  const addr = `${pick(['Av. Providencia', 'Los Leones', 'Irarrázaval', 'Av. Libertad', 'Barros Arana', "O'Higgins"])} ${100 + Math.floor(rnd() * 2900)}, ${pick(cities)}`;
  const it = pick(items);
  const needsHuman = i === 1 || i === 5 ? 1 : 0;
  const msgs = [];
  let t = t0;
  const add = (dir, sender, body, kind = 'text', meta = null) => { t += (dir === 'in' ? 40 + rnd() * 400 : 2 + rnd() * 6) * 1000; msgs.push([dir, sender, kind, body, meta, t]); };
  add('in', 'customer', pick(['Hola! quiero confirmar mi compra', `Hola, mi pedido es el #${num}`, 'Buenas, compré recién en la página', 'Hola 👋']));
  add('out', 'bot', `¡Hola ${name.split(' ')[0]}! 👋 Gracias por tu compra en Her Essence.\n\nEste es tu pedido *#${num}*:\n🛍️ ${it}\n📍 ${addr}\n💰 Total: $${total.toLocaleString('es-CL')}\n\n¿Confirmas el pedido para despacharlo?`, 'buttons', JSON.stringify({ buttons: ['✅ Confirmar', '❌ Cancelar', '💬 Hablar con alguien'] }));
  if (i === 1) {
    add('in', 'customer', '¿Puedo cambiar la dirección? Me equivoqué en el número de depto');
    add('out', 'ai', 'Te comunico con una persona de nuestro equipo 🙋‍♀️ Te responderemos lo antes posible.');
  } else if (i === 5) {
    add('in', 'customer', '💬 Hablar con alguien', 'button');
    add('out', 'bot', 'Te comunico con una persona de nuestro equipo 🙋‍♀️ Te responderemos lo antes posible.');
    add('in', 'customer', 'Quería saber si el perfume viene con caja de regalo');
  } else if (status === 'confirmed') {
    if (by === 'ai') { add('in', 'customer', '¿Cuánto se demora en llegar a regiones?'); add('out', 'ai', 'Los despachos a regiones llegan en 3 a 6 días hábiles 🚚 ¿Confirmas tu pedido?'); }
    add('in', 'customer', by === 'bot' ? '✅ Confirmar' : 'Sí, confirmo', by === 'bot' ? 'button' : 'text');
    add('out', by === 'human' ? 'human' : by, `¡Listo! Tu pedido *#${num}* quedó confirmado ✅\nTe avisaremos cuando sea despachado. ¡Gracias por comprar en Her Essence! 💛`);
  } else if (status === 'cancelled') {
    add('in', 'customer', '❌ Cancelar', 'button');
    add('out', 'bot', `¿Seguro que quieres cancelar el pedido #${num}?`, 'buttons', JSON.stringify({ buttons: ['Sí, cancelar', 'No, lo mantengo'] }));
    add('in', 'customer', 'Sí, cancelar', 'button');
    add('out', 'bot', `Tu pedido *#${num}* fue cancelado. Si fue un error o quieres cambiar algo, escríbenos y te ayudamos 🙌`);
  }
  if (t > Date.now()) t = Date.now() - 60e3;
  const lastIn = [...msgs].reverse().find((m) => m[0] === 'in');
  insC.run(wa, name.split(' ')[0], needsHuman, needsHuman, i === 1 ? 'El cliente quiere cambiar la dirección de despacho' : i === 5 ? 'El cliente pidió hablar con una persona' : null, needsHuman || i < 3 ? 1 + (i % 2) : 0, iso(Math.min(lastIn[5], Date.now())), iso(Math.min(msgs.at(-1)[5], Date.now())), iso(t0));
  for (const m of msgs) insM.run(wa, m[0], m[1], m[2], m[3], m[4], m[0] === 'out' ? pick(['read', 'read', 'delivered']) : null, iso(Math.min(m[5], Date.now())));
  const resolvedAt = status === 'pending' ? null : iso(Math.min(msgs.at(-1)[5], Date.now()));
  insO.run(`gid://shopify/Order/${50000 + i}`, `#${num}`, wa, name, `+${wa.slice(0, 2)} ${wa[2]} ${wa.slice(3, 7)} ${wa.slice(7)}`, String(total), 'CLP', it, addr, status, status === 'pending' ? null : by, iso(t0 - 600e3), iso(t0 + 1000), resolvedAt);
}
// Resultado de la validación de dirección
for (const o of db.prepare('SELECT id, address FROM orders').all()) {
  const [street, city] = String(o.address || '').split(', ');
  db.prepare('UPDATE orders SET street = ?, city = ?, addr_status = ?, addr_detail = ? WHERE id = ?').run(street, city, 'ok',
    JSON.stringify({ status: 'ok', reasons: [`Encontrada en Google Maps: ${o.address}, Chile`], formatted: `${o.address}, Chile`, mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` }), o.id);
}
{
  const o = db.prepare("SELECT o.* FROM orders o JOIN contacts c ON c.wa_id = o.wa_id WHERE c.human_reason LIKE '%dirección%'").get();
  if (o) {
    const [street, city] = o.address.split(', ');
    db.prepare('UPDATE orders SET addr_status = ?, addr_detail = ? WHERE id = ?').run('dudosa', JSON.stringify({ status: 'dudosa',
      reasons: [`Google encontró la calle ${street.replace(/\s\d+.*/, '')} pero no el número ${street.match(/\d+/)[0]}`], formatted: `${street.replace(/\s\d+.*/, '')}, ${city}, Chile`,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` }), o.id);
  }
}

// Todos los pedidos también existen en la tienda
db.exec(`INSERT INTO shop_orders (id, name, created_at, cancelled, customer_name, phone, total, currency, items, address, first_seen_at)
  SELECT id, name, order_created_at, 0, customer_name, phone, total, currency, items, address, linked_at FROM orders`);
// Pedidos que terminaron la compra pero no enviaron el mensaje
const insS = db.prepare(`INSERT INTO shop_orders (id, name, created_at, cancelled, customer_name, phone, total, currency, items, address, first_seen_at, reminder_status, reminder_at, reminder_error)
  VALUES (?,?,?,0,?,?,?,?,?,?,?,?,?,?)`);
const silent = [
  ['Bárbara Pino', '+56 9 6123 4401', 35, null], ['Sofía Ramírez', '9 7234 5512', 70, 'sent'], ['Gabriela Núñez', '+56 9 8345 6623', 140, 'sent'],
  ['Florencia Vidal', '2 2345 678', 200, 'failed'], ['Agustina Bravo', '+56 9 9456 7734', 26 * 60, null], ['Emilia Cortés', '+56 9 5567 8845', 3 * 1440, 'sent'],
  ['Renata Guzmán', '+56 9 4678 9956', 5 * 1440, null], ['Amanda Rivas', '+56 9 3789 0067', 9 * 1440, 'sent'],
];
silent.forEach(([n, ph, mins, st], k) => {
  const created = Date.now() - mins * 60e3;
  const total = [14990, 24990, 29990, 39980][k % 4];
  if (st === 'sent') {
    const wa = `569${ph.replace(/\D/g, '').slice(-8)}`;
    const at = iso(created + 30 * 60e3);
    insC.run(wa, n.split(' ')[0], 0, 0, null, 0, null, at, at);
    insM.run(wa, 'out', 'bot', 'template', `Recordatorio automático (plantilla "confirmar_pedido") para confirmar el pedido #${1240 + k}`, JSON.stringify({ template: 'confirmar_pedido' }), 'delivered', at);
    insO.run(`gid://shopify/Order/${60000 + k}`, `#${1240 + k}`, wa, n, ph, '0', 'CLP', null, null, 'pending', null, iso(created), at, null);
  }
  insS.run(`gid://shopify/Order/${60000 + k}`, `#${1240 + k}`, iso(created), n, ph, String(total), 'CLP', pick(items), `${pick(['Av. Matta', 'San Martín', 'Pedro de Valdivia'])} ${300 + k * 41}, ${pick(cities)}`, iso(created), st, st ? iso(created + 30 * 60e3) : null, st === 'failed' ? 'Teléfono no válido: 2 2345 678' : null);
});
db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('reminders_since', iso(Date.now() - 30 * 86400e3));
db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('last_sync_at', iso(Date.now() - 60e3));
console.log(`Listo: ${N} conversaciones y ${silent.length} pedidos sin mensaje de ejemplo.`);
