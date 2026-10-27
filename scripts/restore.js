// Se ejecuta antes de iniciar el servidor. Si MIGRATE_FROM está definido y este servidor aún no tiene base de datos,
// trae todo (conversaciones, pedidos, audios, fotos) desde el servidor viejo, usando la misma DASHBOARD_PASSWORD.
// Si ya hay base de datos, no hace nada (es seguro dejar la variable puesta).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const from = (process.env.MIGRATE_FROM || '').trim().replace(/\/+$/, '');
const dataDir = process.env.DATA_DIR || './data';
const dbFile = path.join(dataDir, 'wa.db');

async function main() {
  if (!from) return;
  if (fs.existsSync(dbFile)) { console.log('[traslado] Ya hay base de datos aquí: no se trae nada.'); return; }
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error('Falta DASHBOARD_PASSWORD (debe ser la misma del servidor viejo)');

  console.log(`[traslado] Trayendo datos desde ${from} …`);
  const login = await fetch(`${from}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!login.ok) throw new Error(`No se pudo entrar al servidor viejo (${login.status}). ¿La DASHBOARD_PASSWORD es la misma?`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const r = await fetch(`${from}/api/admin/export`, { headers: { Cookie: cookie } });
  if (!r.ok) throw new Error(`El servidor viejo no entregó los datos (${r.status}). ¿Tiene la versión nueva desplegada?`);
  const raw = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));

  const tmpDir = path.join(dataDir, `.restore-${Date.now()}`);
  fs.mkdirSync(path.join(tmpDir, 'media'), { recursive: true });
  let i = 0; let n = 0;
  while (i < raw.length) {
    const nl = raw.indexOf(0x0a, i);
    const { name, size } = JSON.parse(raw.subarray(i, nl).toString('utf8'));
    if (!/^(wa\.db|media\/[\w.-]+)$/.test(name)) throw new Error(`Archivo inesperado en el paquete: ${name}`);
    fs.writeFileSync(path.join(tmpDir, name), raw.subarray(nl + 1, nl + 1 + size));
    i = nl + 1 + size; n++;
  }
  if (!fs.existsSync(path.join(tmpDir, 'wa.db'))) throw new Error('El paquete no trae la base de datos');

  // mover a su lugar: primero los archivos, al final la base de datos
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(tmpDir, 'media'))) fs.renameSync(path.join(tmpDir, 'media', f), path.join(mediaDir, f));
  fs.renameSync(path.join(tmpDir, 'wa.db'), dbFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[traslado] Listo: ${n} archivos (${(raw.length / 1e6).toFixed(1)} MB).`);
}

main().catch((e) => {
  console.error('[traslado] ERROR:', e.message);
  process.exit(1); // no arrancar con la base vacía
});
