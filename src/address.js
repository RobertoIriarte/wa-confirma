// Valida que la dirección de despacho exista: con Google Maps si hay clave, si no con OpenStreetMap (gratis).
// Resultado: ok | dudosa | no_encontrada | sin_validar (sin clave o error de Google: no bloquea nada)
import { config } from './config.js';
import * as db from './db.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC = new Set(['av', 'avda', 'avenida', 'calle', 'pasaje', 'pje', 'psje', 'pasj', 'camino', 'cam', 'los', 'las', 'el', 'la', 'de', 'del', 'y', 'n', 'nro', 'numero', 'poblacion', 'pob', 'villa', 'sector', 'block', 'depto']);
const significant = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w));

// Número de la dirección: el último número antes de "depto", "casa", "block", etc.
export function streetNumber(street) {
  const main = String(street || '').split(/\b(depto|dpto|departamento|depart|casa|block|blk|torre|of|oficina|piso|parcela)\b/i)[0];
  const nums = main.match(/\d{1,6}/g);
  return nums ? nums[nums.length - 1].replace(/^0+/, '') : null;
}

const mapsSearch = (q, placeId) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}${placeId ? `&query_place_id=${placeId}` : ''}`;

async function geocode(query) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('components', `country:${config.maps.country}`);
  url.searchParams.set('region', config.maps.country.toLowerCase());
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', config.maps.apiKey);
  const res = await fetch(url);
  return res.json();
}

// OpenStreetMap (Nominatim): gratis, máx. 1 consulta por segundo. Se traduce al formato de Google para reutilizar judge().
let lastOsm = 0;
const ABBR = [[/\bpje\.?\s*/gi, 'Pasaje '], [/\bpsje\.?\s*/gi, 'Pasaje '], [/\bavda?\.?\s+/gi, 'Avenida '], [/\bav\.\s*/gi, 'Avenida '], [/\bgral\.?\s*/gi, 'General '], [/\bstgo\.?\b/gi, 'Santiago']];
const expand = (t) => ABBR.reduce((acc, [re, rep]) => acc.replace(re, rep), t);

async function osmSearch(q) {
  const wait = 1100 - (Date.now() - lastOsm);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOsm = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  if (typeof q === 'string') url.searchParams.set('q', q);
  else { if (q.street) url.searchParams.set('street', q.street); if (q.city) url.searchParams.set('city', q.city); url.searchParams.set('country', 'Chile'); }
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', config.maps.country.toLowerCase());
  url.searchParams.set('accept-language', 'es');
  const res = await fetch(url, { headers: { 'User-Agent': `${config.store.name.replace(/[^\w ]/g, '')}-confirmaciones/1.0` } });
  if (!res.ok) throw Object.assign(new Error(`HTTP_${res.status}`), { http: true });
  return res.json();
}

async function osmGeocode({ street, city, province }) {
  // Solo la calle y el número: sin el sector/villa que viene después de la coma, sin depto/casa y sin ceros a la izquierda
  const main = expand(street.split(',')[0].split(/\b(depto|dpto|departamento|casa|block|torre|of|oficina|piso|sitio|lote)\b/i)[0])
    .replace(/\b0+(\d)/g, '$1').trim();
  const noNumber = main.replace(/\b(n[°º]?|nro\.?|#)?\s*\d+\s*$/i, '').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  let list;
  try {
    list = await osmSearch([main, city, 'Chile'].filter(Boolean).join(', '));
    // Si no aparece con número, se busca solo la calle en la comuna
    if (!list.length && noNumber && noNumber !== main) list = await osmSearch([noNumber, city, 'Chile'].filter(Boolean).join(', '));
    // Último intento: búsqueda estructurada (calle + comuna)
    if (!list.length && noNumber) list = await osmSearch({ street: noNumber, city });
  } catch (e) {
    return { status: e.http ? e.message : 'ERROR', source: 'osm' };
  }
  if (!list.length) return { status: 'ZERO_RESULTS', source: 'osm', results: [] };
  const h = list[0], a = h.address || {};
  const comps = [];
  if (a.house_number) comps.push({ long_name: a.house_number, types: ['street_number'] });
  const road = a.road || a.pedestrian || a.footway || a.residential;
  if (road) comps.push({ long_name: road, types: ['route'] });
  for (const k of ['city', 'town', 'village', 'municipality', 'suburb', 'city_district', 'county', 'hamlet']) {
    if (a[k]) comps.push({ long_name: a[k], types: ['locality'] });
  }
  return { status: 'OK', source: 'osm', results: [{ formatted_address: h.display_name, place_id: null, address_components: comps, geometry: { location: { lat: Number(h.lat), lng: Number(h.lon) } } }] };
}

// Simulación para el modo DEMO (sin clave): direcciones con "999" no existen, sin número = dudosa
function demoGeocode(street, city) {
  if (/999/.test(street)) return { status: 'ZERO_RESULTS', results: [] };
  const num = streetNumber(street);
  const route = street.replace(/\d.*$/, '').trim();
  return { status: 'OK', results: [{
    formatted_address: `${street.split(',')[0]}, ${city}, Chile`, place_id: 'demo', types: num ? ['street_address'] : ['route'],
    geometry: { location: { lat: -33.45, lng: -70.66 }, location_type: num ? 'ROOFTOP' : 'GEOMETRIC_CENTER' },
    address_components: [
      ...(num ? [{ long_name: num, types: ['street_number'] }] : []),
      { long_name: route, types: ['route'] }, { long_name: city, types: ['locality', 'political'] },
    ],
  }] };
}

/**
 * Analiza la respuesta de Google y decide.
 * Devuelve { status, reasons: [], formatted, mapsUrl, lat, lng, google_city }
 */
export function judge({ street, city }, data) {
  const SRC = data.source === 'osm' ? 'OpenStreetMap' : 'Google Maps';
  const query = [street, city].filter(Boolean).join(', ');
  const out = { status: 'ok', reasons: [], formatted: null, mapsUrl: mapsSearch(`${query}, Chile`), lat: null, lng: null };
  const wantedNumber = streetNumber(street);
  if (!wantedNumber) out.reasons.push('La dirección no tiene número de casa o edificio');

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    // Error de Google (clave, cuota, etc.): no se bloquea el pedido
    return { ...out, status: 'sin_validar', reasons: [`${SRC} respondió ${data.status}${data.error_message ? `: ${data.error_message}` : ''}`] };
  }
  if (data.status === 'ZERO_RESULTS' || !data.results?.length) {
    return { ...out, status: 'no_encontrada', reasons: [`${SRC} no encontró esta dirección`, ...out.reasons] };
  }

  const r = data.results[0];
  const comp = (type) => r.address_components.find((c) => c.types.includes(type));
  const route = comp('route')?.long_name;
  const number = comp('street_number')?.long_name?.replace(/^0+/, '');
  const places = r.address_components
    .filter((c) => c.types.some((t) => ['locality', 'administrative_area_level_3', 'sublocality', 'sublocality_level_1', 'neighborhood'].includes(t)))
    .map((c) => c.long_name);
  Object.assign(out, {
    formatted: r.formatted_address,
    mapsUrl: data.source === 'osm' && r.geometry?.location ? `https://www.google.com/maps?q=${r.geometry.location.lat},${r.geometry.location.lng}` : mapsSearch(r.formatted_address, r.place_id),
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
    google_city: places[0] || null,
  });

  if (!route) {
    out.status = 'no_encontrada';
    out.reasons.unshift(`${SRC} no encontró la calle; solo ubicó ${places[0] ? `la zona de ${places[0]}` : 'la región'}`);
    return out;
  }
  // ¿Es la misma calle?
  const wantWords = significant((data.source === 'osm' ? expand(street) : street).split(/\d/)[0]);
  const gotWords = new Set(significant(route));
  if (wantWords.length && !wantWords.some((w) => gotWords.has(w))) {
    out.status = 'dudosa';
    out.reasons.push(`${SRC} la ubicó en otra calle: ${route}`);
  }
  // ¿Es la misma comuna?
  if (city && places.length) {
    const c = norm(city);
    if (!places.some((p) => { const n = norm(p); return n === c || n.includes(c) || c.includes(n); })) {
      out.status = 'dudosa';
      out.reasons.push(`La calle aparece en ${places[0]}, no en ${city}`);
    }
  }
  // ¿Encontró el número?
  if (wantedNumber && !number && data.source === 'osm') {
    if (out.status === 'ok')
    // OpenStreetMap casi no tiene numeración en Chile: si la calle y la comuna calzan, se da por buena
    out.reasons.push(`Calle verificada en OpenStreetMap (no tiene registrado el número ${wantedNumber})`);
  } else if (wantedNumber && number !== wantedNumber) {
    out.status = 'dudosa';
    out.reasons.push(number ? `${SRC} ubicó el número ${number}, no el ${wantedNumber}` : `${SRC} encontró la calle ${route} pero no el número ${wantedNumber}`);
  }
  if (!wantedNumber && out.status === 'ok') out.status = 'dudosa';
  if (out.status === 'ok' && !out.reasons.length) out.reasons.push(`Encontrada en ${SRC}: ${r.formatted_address}`);
  return out;
}

export async function checkAddress(order) {
  const street = order.street || String(order.address || '').split(',')[0];
  const city = order.city || '';
  if (!street) return { status: 'no_encontrada', reasons: ['El pedido no tiene dirección'], mapsUrl: null };
  try {
    const data = config.maps.apiKey ? await geocode([street, city, order.province, 'Chile'].filter(Boolean).join(', '))
      : config.demo ? demoGeocode(street, city)
      : await osmGeocode({ street, city, province: order.province });
    return judge({ street, city }, data);
  } catch (e) {
    return { status: 'sin_validar', reasons: [`No se pudo consultar el mapa: ${e.message}`], mapsUrl: mapsSearch(`${street}, ${city}, Chile`) };
  }
}

// Valida una vez por pedido (o de nuevo si force) y guarda el resultado
export async function ensureAddressChecked(order, force = false) {
  if (!order) return order;
  if (order.addr_status && order.addr_status !== 'sin_validar' && !force) return order;
  const r = await checkAddress(order);
  db.setAddressCheck(order.id, r.status, r);
  db.logEvent(order.wa_id, order.id, 'address_checked', `${r.status}: ${r.reasons.join('; ')}`);
  return db.getOrder(order.id);
}

export const addressDetail = (order) => { try { return JSON.parse(order?.addr_detail || '{}'); } catch { return {}; } };
