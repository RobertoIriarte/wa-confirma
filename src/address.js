// Valida que la dirección de despacho exista, usando la API de geocodificación de Google Maps.
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
  const query = [street, city].filter(Boolean).join(', ');
  const out = { status: 'ok', reasons: [], formatted: null, mapsUrl: mapsSearch(`${query}, Chile`), lat: null, lng: null };
  const wantedNumber = streetNumber(street);
  if (!wantedNumber) out.reasons.push('La dirección no tiene número de casa o edificio');

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    // Error de Google (clave, cuota, etc.): no se bloquea el pedido
    return { ...out, status: 'sin_validar', reasons: [`Google Maps respondió ${data.status}${data.error_message ? `: ${data.error_message}` : ''}`] };
  }
  if (data.status === 'ZERO_RESULTS' || !data.results?.length) {
    return { ...out, status: 'no_encontrada', reasons: ['Google Maps no encontró esta dirección', ...out.reasons] };
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
    mapsUrl: mapsSearch(r.formatted_address, r.place_id),
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
    google_city: places[0] || null,
  });

  if (!route) {
    out.status = 'no_encontrada';
    out.reasons.unshift(`Google no encontró la calle; solo ubicó ${places[0] ? `la zona de ${places[0]}` : 'la región'}`);
    return out;
  }
  // ¿Es la misma calle?
  const wantWords = significant(street.split(/\d/)[0]);
  const gotWords = new Set(significant(route));
  if (wantWords.length && !wantWords.some((w) => gotWords.has(w))) {
    out.status = 'dudosa';
    out.reasons.push(`Google la ubicó en otra calle: ${route}`);
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
  if (wantedNumber && number !== wantedNumber) {
    out.status = 'dudosa';
    out.reasons.push(number ? `Google ubicó el número ${number}, no el ${wantedNumber}` : `Google encontró la calle ${route} pero no el número ${wantedNumber}`);
  }
  if (!wantedNumber && out.status === 'ok') out.status = 'dudosa';
  if (out.status === 'ok') out.reasons.push(`Encontrada en Google Maps: ${r.formatted_address}`);
  return out;
}

export async function checkAddress(order) {
  const street = order.street || String(order.address || '').split(',')[0];
  const city = order.city || '';
  if (!street) return { status: 'no_encontrada', reasons: ['El pedido no tiene dirección'], mapsUrl: null };
  if (!config.maps.apiKey && !config.demo) return { status: 'sin_validar', reasons: ['Falta GOOGLE_MAPS_API_KEY'], mapsUrl: mapsSearch(`${street}, ${city}, Chile`) };
  try {
    const data = config.maps.apiKey ? await geocode([street, city, order.province, 'Chile'].filter(Boolean).join(', ')) : demoGeocode(street, city);
    return judge({ street, city }, data);
  } catch (e) {
    return { status: 'sin_validar', reasons: [`No se pudo consultar Google Maps: ${e.message}`], mapsUrl: mapsSearch(`${street}, ${city}, Chile`) };
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
