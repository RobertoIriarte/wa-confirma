// Prueba qué ofrece la API de integraciones de Dropi con DROPI_TOKEN (no imprime el token).
// Uso en la consola de Railway: node scripts/dropi-probe.js
const token = process.env.DROPI_TOKEN;
if (!token) { console.log('Falta DROPI_TOKEN'); process.exit(1); }
console.log('token: largo', token.length);

const bases = (process.env.DROPI_BASE ? [process.env.DROPI_BASE] : ['https://api.dropi.cl', 'https://api.dropi.co/cl', 'https://api.dropi.co']);
const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
const qs = `?orderBy=id&orderDirection=desc&result_number=3&start=0&filter_date_by=FECHA%20DE%20CREADO&from=${from}&until=${today}`;
const tries = [
  ['GET', `/integrations/orders/myorders${qs}`],
  ['POST', '/integrations/orders/myorders', { result_number: 3, start: 0, from, until: today, filter_date_by: 'FECHA DE CREADO' }],
  ['GET', '/integrations/orders/fingerprint?phone=986251583'],
  ['GET', '/integrations/fingerprint/986251583'],
  ['GET', '/integrations/customers/fingerprint?phone=986251583'],
  ['GET', '/integrations/huella/986251583'],
];
const short = (s) => s.replace(/("(?:customer_phone|phone|email|dir|address|customer_email)"\s*:\s*")[^"]*/gi, '$1…').slice(0, 700);

for (const base of bases) {
  for (const [method, path, body] of tries) {
    try {
      const r = await fetch(base + path, {
        method,
        headers: { 'dropi-integration-key': token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const t = await r.text();
      console.log(`\n${method} ${base}${path.split('?')[0]} → ${r.status}\n${short(t)}`);
    } catch (e) {
      console.log(`\n${method} ${base}${path.split('?')[0]} → ERROR ${e.message}`);
    }
  }
}
