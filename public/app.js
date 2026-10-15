// Panel de confirmaciones por WhatsApp
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { status: null, filter: 'all', q: '', current: null, convs: [], detail: null, days: 7, view: 'inbox', lastStatus: {} };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- formato ----------
const tz = 'America/Santiago';
const money = (a, c) => { const n = Number(a); if (!Number.isFinite(n)) return '—'; try { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: c || 'CLP', maximumFractionDigits: !c || c === 'CLP' ? 0 : 2 }).format(n); } catch { return `${n} ${c || ''}`; } };
const time = (iso) => new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const dateLong = (iso) => new Date(iso).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (dayKey(iso) === dayKey(new Date().toISOString())) return time(iso);
  if (s < 6 * 86400) return new Date(iso).toLocaleDateString('es-CL', { weekday: 'short', timeZone: tz });
  return new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', timeZone: tz });
}
const elapsed = (iso) => {
  const min = Math.max(0, (Date.now() - new Date(iso)) / 60e3);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${Math.round(min)} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
};
const phone = (wa) => { const d = String(wa); return d.startsWith('56') && d.length === 11 ? `+56 ${d[2]} ${d.slice(3, 7)} ${d.slice(7)}` : `+${d}`; };
const samePhone = (a, b) => { const x = String(a || '').replace(/\D/g, ''), y = String(b || '').replace(/\D/g, ''); return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8); };
const STATUS = { pending: 'Pendiente', confirmed: 'Confirmado', cancelled: 'Cancelado' };
const STATUS_ICON = { pending: '◷', confirmed: '✓', cancelled: '✕' };
const badge = (s) => (s ? `<span class="badge ${s}">${STATUS_ICON[s]} ${STATUS[s]}</span>` : '');
const SENDER = { bot: 'Bot', ai: 'IA', human: 'Equipo', customer: '' };
const BY = { bot: 'el bot', ai: 'la IA', human: 'el equipo' };
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
function dur(secs) {
  if (secs == null) return '—';
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return `${(secs / 3600).toFixed(1).replace('.', ',')} h`;
}

// ---------- login ----------
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#password').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try { await api('/api/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; start(); }
  catch (err) { $('#loginError').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout'); showLogin(); });

// ---------- navegación ----------
$$('.rail-link').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
function setView(v) {
  state.view = v;
  $$('.rail-link').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#view-inbox').hidden = v !== 'inbox';
  $('#view-metrics').hidden = v !== 'metrics';
  $('#view-silent').hidden = v !== 'silent';
  if (v === 'metrics') loadMetrics();
  if (v === 'silent') loadSilent();
}

// ---------- pedidos sin mensaje ----------
const REM = { sent: ['sent', 'Recordatorio enviado'], failed: ['failed', 'Recordatorio no enviado'], skipped: ['', 'Sin recordatorio'] };
async function loadSilent() {
  const showDismissed = $('#showDismissed').checked;
  const d = await api(`/api/silent${showDismissed ? '?dismissed=1' : ''}`);
  if (!showDismissed) {
    const pendingCount = d.orders.filter((o) => o.reminder_status !== 'sent').length;
    $('#silentCount').hidden = !pendingCount;
    $('#silentCount').textContent = pendingCount;
  }
  if (state.view !== 'silent') return;
  $('#reminderInfo').innerHTML = d.remindersEnabled
    ? `<div class="note"><p>Recordatorio automático activo: a los ${d.afterMinutes} min se envía la plantilla <code>${esc(d.template)}</code>, una sola vez por pedido y fuera del horario nocturno. Si la clienta toca Confirmar o Cancelar, el pedido se actualiza solo.</p></div>`
    : `<div class="note"><p>El recordatorio automático está apagado. Para activarlo, crea una plantilla de WhatsApp en Meta y pon su nombre en <code>REMINDER_TEMPLATE</code> (los pasos están en la guía). Mientras tanto puedes llamar a estas clientas.</p></div>`;
  const body = $('#silentBody');
  if (!d.orders.length) {
    body.innerHTML = `<div class="silent-empty"><p class="empty-title">${showDismissed ? 'No hay pedidos descartados' : 'Todas las clientas escribieron'}</p><p class="muted">${showDismissed ? '' : `Aquí aparecen los pedidos que llevan más de ${d.graceMinutes} min sin enviar el mensaje.`} Última revisión de Shopify: ${d.lastSyncAt ? ago(d.lastSyncAt) : 'pendiente'}.</p></div>`;
    return;
  }
  body.innerHTML = `<ul class="silent-list">${d.orders.map((o) => {
    const [cls, label] = REM[o.reminder_status] || ['', 'Sin mensaje'];
    const tel = o.wa_id ? `+${o.wa_id}` : null;
    return `<li class="silent-row">
      <span class="silent-num">${esc(o.name)}</span>
      <span class="silent-who"><strong>${esc(o.customer_name || 'Sin nombre')}</strong><span>${esc(o.phone || 'Sin teléfono')}</span></span>
      <span class="silent-amount"><span class="silent-total">${money(o.total, o.currency)}</span><br><span class="silent-when">${elapsed(o.created_at)}</span></span>
      <span class="silent-state"><span class="state-pill ${cls}">${label}</span>${o.reminder_at ? ` <span class="muted">${elapsed(o.reminder_at)}</span>` : ''}${o.reminder_error ? `<span class="err">${esc(o.reminder_error)}</span>` : ''}</span>
      <span class="silent-actions">
        ${tel ? `<a class="btn" href="tel:${tel}">Llamar</a>` : ''}
        ${o.reminder_status === 'sent' && o.wa_id ? `<button class="btn" data-chat="${esc(o.wa_id)}">Ver chat</button>` : ''}
        ${d.remindersEnabled && o.reminder_status !== 'sent' && tel ? `<button class="btn primary" data-remind="${esc(o.id)}">Enviar recordatorio</button>` : ''}
        ${o.admin_url ? `<a class="btn" href="${esc(o.admin_url)}" target="_blank" rel="noopener">Ver en Shopify</a>` : ''}
        <button class="btn" data-dismiss="${esc(o.id)}" data-val="${o.dismissed ? 0 : 1}">${o.dismissed ? 'Restaurar' : 'Descartar'}</button>
      </span>
    </li>`;
  }).join('')}</ul>`;
}
$('#silentBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.remind) { b.disabled = true; await api(`/api/silent/${encodeURIComponent(b.dataset.remind)}/remind`, { method: 'POST' }); toast('Recordatorio enviado'); }
    if (b.dataset.dismiss) { await api(`/api/silent/${encodeURIComponent(b.dataset.dismiss)}/dismiss`, { method: 'POST', body: { dismissed: b.dataset.val === '1' } }); toast(b.dataset.val === '1' ? 'Pedido descartado de la lista' : 'Pedido restaurado'); }
    if (b.dataset.chat) { setView('inbox'); openConv(b.dataset.chat); return; }
  } catch (err) { toast(err.message); b.disabled = false; }
  loadSilent();
});
$('#showDismissed').addEventListener('change', loadSilent);
$('#syncNow').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { const r = await api('/api/silent/sync', { method: 'POST' }); toast(r.skipped ? 'Shopify no está conectado' : `Revisados ${r.count} pedidos`); }
  catch (err) { toast(err.message); }
  e.target.disabled = false;
  loadSilent();
});

// ---------- estado del sistema ----------
function renderHealth(s) {
  $('#storeName').textContent = s.store;
  document.title = `${s.store}: confirmaciones`;
  const shop = s.shopify?.ok ? ['on', `Shopify: ${s.shopify.shop}`] : s.demo ? ['sim', 'Shopify: pedidos de ejemplo'] : ['', `Shopify: ${s.shopify?.reason || 'sin conectar'}`];
  const items = [
    s.whatsapp ? ['on', 'WhatsApp conectado'] : ['sim', 'WhatsApp simulado'],
    shop,
    s.ai ? ['on', `IA activa (${s.aiName || ''})`] : ['', 'IA desactivada'],
    s.maps ? ['on', 'Google Maps activo'] : s.demo ? ['sim', 'Google Maps simulado'] : ['', 'Google Maps sin configurar'],
  ];
  $('#health').innerHTML = items.map(([c, t]) => `<li><span class="dot ${c}"></span>${esc(t)}</li>`).join('');
  $('#simulator').hidden = !s.demo;
}

// ---------- bandeja ----------
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  state.filter = b.dataset.filter;
  $$('.chip').forEach((c) => c.classList.toggle('active', c === b));
  loadList();
});
let searchT;
$('#search').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => { state.q = e.target.value; loadList(); }, 200); });

async function loadList() {
  const list = await api(`/api/conversations?filter=${state.filter}&q=${encodeURIComponent(state.q)}`);
  state.convs = list;
  const attention = list.filter((c) => c.needs_human).length;
  $('#attentionCount').hidden = !attention;
  $('#attentionCount').textContent = attention;
  const ul = $('#convList');
  if (!list.length) {
    const demoBtn = state.status?.demo ? '<p><button class="btn" id="openSim">Simular un cliente</button></p>' : '';
    ul.innerHTML = `<li class="list-empty">${state.filter === 'all' && !state.q ? 'Todavía no hay conversaciones. Aparecerán aquí cuando un cliente escriba a tu número.' : 'Nada coincide con este filtro.'}${demoBtn}</li>`;
    $('#openSim')?.addEventListener('click', () => $('#newSim').showModal());
    return;
  }
  ul.innerHTML = list.map((c) => `
    <li class="conv ${c.wa_id === state.current ? 'active' : ''} ${c.needs_human ? 'attention' : ''}" data-id="${esc(c.wa_id)}" tabindex="0">
      <span class="conv-name">${esc(c.name || phone(c.wa_id))}</span>
      <span class="conv-time">${ago(c.last_message_at)}</span>
      <span class="conv-last">${c.last_sender && c.last_sender !== 'customer' ? `${SENDER[c.last_sender] || ''}: ` : ''}${esc(c.last_body || '')}</span>
      <span class="conv-meta">
        ${c.bot_paused && !c.needs_human ? '<span class="badge paused">Bot pausado</span>' : ''}
        ${badge(c.order_status)}
        ${c.unread ? `<span class="unread" aria-label="${c.unread} sin leer">${c.unread}</span>` : ''}
      </span>
    </li>`).join('') + (state.status?.demo ? '<li class="list-empty"><button class="btn" id="openSim">Simular otro cliente</button></li>' : '');
  $('#openSim')?.addEventListener('click', () => $('#newSim').showModal());
}
$('#convList').addEventListener('click', (e) => { const li = e.target.closest('.conv'); if (li) openConv(li.dataset.id); });
$('#convList').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = e.target.closest('.conv'); if (li) openConv(li.dataset.id); } });

async function openConv(id) {
  state.current = id;
  $$('.conv').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
  $('#view-inbox').classList.add('chat-open');
  $('#chatEmpty').hidden = true; $('#chat').hidden = false;
  await loadConv(true);
  loadList();
}
$('#backToList').addEventListener('click', () => { $('#view-inbox').classList.remove('chat-open'); $('#orderPane').classList.remove('open'); });
$('#toggleOrder').addEventListener('click', () => $('#orderPane').classList.toggle('open'));

async function loadConv(scroll = false) {
  if (!state.current) return;
  const prevStatus = state.detail?.orders?.[0]?.status;
  const d = await api(`/api/conversations/${encodeURIComponent(state.current)}`);
  const prevCount = state.detail?.contact?.wa_id === d.contact.wa_id ? state.detail.messages.length : -1;
  state.detail = d;
  const c = d.contact;
  $('#chatName').textContent = c.name || phone(c.wa_id);
  $('#chatPhone').textContent = phone(c.wa_id);
  $('#botToggle').checked = !c.bot_paused;
  $('#botLabel').textContent = c.bot_paused ? 'Bot pausado' : 'Bot activo';
  $('#botLabel').dataset.short = c.bot_paused ? 'Pausado' : 'Bot';
  const banner = $('#humanBanner');
  if (c.needs_human) {
    banner.hidden = false;
    banner.innerHTML = `<span><strong>Necesita a una persona.</strong> ${esc(c.human_reason || '')}</span><button class="btn" id="resumeBot">Devolver al bot</button>`;
    $('#resumeBot').onclick = () => setBot(false);
  } else banner.hidden = true;
  $('#windowNote').hidden = d.windowOpen;
  $('#replyText').disabled = !d.windowOpen && !state.status?.demo;

  if (prevCount !== d.messages.length || scroll) renderMessages(d.messages, scroll || prevCount !== d.messages.length);
  else renderMessages(d.messages, false);
  renderOrder(d, prevStatus);
}

function renderMessages(msgs, scrollDown) {
  const ol = $('#messages');
  const nearBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 80;
  let lastDay = '';
  ol.innerHTML = msgs.map((m) => {
    const day = dayKey(m.created_at);
    const sep = day !== lastDay ? `<li class="day-sep">${dateLong(m.created_at)}</li>` : '';
    lastDay = day;
    const out = m.direction === 'out';
    const ticks = out ? ({ sent: '✓', delivered: '✓✓', read: '✓✓ leído', failed: 'no enviado' })[m.status] || '' : '';
    const buttons = m.kind === 'buttons' && m.meta?.buttons ? `<div class="msg-buttons">${m.meta.buttons.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : '';
    return `${sep}<li class="msg ${out ? 'out' : 'in'} ${m.sender} ${m.status === 'failed' ? 'failed' : ''}">${esc(m.body)}${buttons}${m.meta?.error ? `<div class="msg-error">${esc(m.meta.error)}</div>` : ''}<div class="msg-foot">${out ? `<span class="who">${SENDER[m.sender] || ''}</span>` : ''}<span>${time(m.created_at)}</span>${ticks ? `<span>${ticks}</span>` : ''}</div></li>`;
  }).join('');
  if (scrollDown || nearBottom) ol.scrollTop = ol.scrollHeight;
}

function renderStrip(o) {
  const strip = $('#orderStrip');
  if (!o) { strip.hidden = false; strip.className = 'order-strip none'; strip.innerHTML = '<span>Sin pedido vinculado</span><span class="strip-go">Vincular</span>'; return; }
  const v = o.dropi ? VERDICT[o.dropi.verdict] : null;
  strip.hidden = false;
  strip.className = `order-strip ${v ? v[0] : ''}`;
  strip.innerHTML = `<strong>${esc(o.name)}</strong>${badge(o.status)}<span class="strip-total">${money(o.total, o.currency)}</span>${v ? `<span class="strip-verdict">${esc(v[1])}</span>` : ''}<span class="strip-go" aria-hidden="true">›</span>`;
}
$('#orderStrip').addEventListener('click', () => $('#orderPane').classList.add('open'));

function renderOrder(d, prevStatus) {
  const pane = $('#orderPane');
  const o = d.orders[0];
  renderStrip(o);
  const closeBtn = '<div class="pane-top"><span class="pane-top-title">Pedido</span><button class="icon-btn pane-close" aria-label="Cerrar pedido" onclick="this.closest(\'.order-pane\').classList.remove(\'open\')"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
  if (!o) {
    pane.innerHTML = `${closeBtn}
      <h2 class="pane-title">Sin pedido vinculado</h2>
      <p class="muted small">El bot busca el pedido por el número que escribe el cliente o por su teléfono. Si no lo encontró, vincúlalo a mano.</p>
      <form class="link-form" id="linkForm">
        <label class="small" for="linkNum">Número de pedido</label>
        <div class="composer-row"><input id="linkNum" placeholder="1001" inputmode="numeric"><button class="btn primary">Vincular</button></div>
      </form>`;
    $('#linkForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/conversations/${encodeURIComponent(state.current)}/link`, { method: 'POST', body: { number: $('#linkNum').value } }); toast('Pedido vinculado'); loadConv(); loadList(); }
      catch (err) { toast(err.message); }
    };
    return;
  }
  const fresh = prevStatus && prevStatus !== o.status ? 'fresh' : '';
  const others = d.orders.slice(1);
  pane.innerHTML = `${closeBtn}
    <article class="receipt">
      <span class="stamp ${o.status} ${fresh}">${STATUS[o.status]}</span>
      <div class="receipt-num">${esc(o.name)}</div>
      <div class="receipt-date">${o.order_created_at ? new Date(o.order_created_at).toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }) : ''}</div>
      <dl>
        <div><dt>Cliente</dt><dd>${esc(o.customer_name || '—')}</dd></div>
        <div><dt>Productos</dt><dd>${esc(o.items || '—')}</dd></div>
        <div><dt>Despacho</dt><dd>${esc(o.address || '—')}${addrLine(o)}</dd></div>
        <div><dt>Historial en Dropi</dt><dd>${histLine(o)}</dd></div>
        <div><dt>Teléfono del pedido</dt><dd>${esc(o.phone || '—')}</dd></div>
      </dl>
      ${!samePhone(o.phone, d.contact.wa_id) ? '<p class="phone-warn">El teléfono del pedido no coincide con este WhatsApp. El bot no muestra los datos de despacho y deriva las cancelaciones a una persona.</p>' : ''}
      <div class="receipt-total"><span class="muted">Total</span><strong>${money(o.total, o.currency)}</strong></div>
      ${o.resolved_by ? `<div class="resolved-by">${STATUS[o.status]} por ${BY[o.resolved_by] || o.resolved_by}, ${ago(o.resolved_at)}</div>` : ''}
    </article>
    ${verdictBlock(o.dropi)}
    <div class="order-actions">
      ${o.status === 'pending' ? `
        <div class="row"><button class="btn confirm" data-act="confirmed">✓ Confirmar</button><button class="btn cancel" data-act="cancelled">✕ Cancelar</button></div>
        <button class="btn" id="resend">Reenviar resumen con botones</button>` : `<button class="btn" data-act="pending">Volver a pendiente</button>`}
      <label class="check"><input type="checkbox" id="notify" checked> Avisar al cliente por WhatsApp</label>
      ${o.status === 'pending' ? `<label class="check"><input type="checkbox" id="cancelShopify" ${state.status?.autoCancel ? 'checked' : ''}> Al cancelar, cancelar también en Shopify (no se puede deshacer)</label>` : ''}
    </div>
    ${others.length ? `<div class="other-orders"><strong>Otros pedidos de este cliente</strong><ul>${others.map((x) => `<li><span>${esc(x.name)}</span>${badge(x.status)}</li>`).join('')}</ul></div>` : ''}`;
  $$('[data-act]', pane).forEach((b) => (b.onclick = () => setOrderStatus(o, b.dataset.act)));
  const rs = $('#resend', pane);
  if (rs) rs.onclick = async () => { try { await api(`/api/conversations/${encodeURIComponent(state.current)}/resend`, { method: 'POST' }); toast('Resumen enviado'); loadConv(); } catch (e) { toast(e.message); } };
}

const ADDR = { ok: ['ok', '✓ Encontrada en Google Maps'], dudosa: ['warn', '⚠ Dirección dudosa'], no_encontrada: ['bad', '✕ No encontrada en Google Maps'], sin_validar: ['', 'Sin validar'] };
function addrLine(o) {
  const [cls, label] = ADDR[o.addr_status] || ['', 'Sin validar'];
  const reasons = (o.addr?.reasons || []).filter((r) => !r.startsWith('Encontrada en'));
  return `<span class="addr-check ${cls}">${label}</span>
    ${reasons.length ? `<span class="addr-reasons">${reasons.map(esc).join('<br>')}</span>` : ''}
    ${o.addr?.formatted && o.addr_status !== 'ok' ? `<span class="addr-reasons">Google sugiere: ${esc(o.addr.formatted)}</span>` : ''}
    <span class="addr-links">${o.addr?.mapsUrl ? `<a href="${esc(o.addr.mapsUrl)}" target="_blank" rel="noopener">Ver en el mapa</a>` : ''}<button class="link-btn" data-recheck="${esc(o.id)}">Validar de nuevo</button></span>`;
}
const VERDICT = { prepago: ['revisar', 'Esperando pago por adelantado'], historial: ['esperando', 'Esperando la revisión de historial'], listo: ['listo', 'Listo para confirmar en Dropi'], revisar: ['revisar', 'Revisar antes de confirmar en Dropi'], esperando: ['esperando', 'Esperando que la clienta confirme'], no_despachar: ['no', 'No despachar: cancelar en Dropi'] };
function histLine(o) {
  const h = { ok: ['ok', `✓ ${o.hist_rate ?? ''}% positivo`], bajo: ['bad', `✕ ${o.hist_rate ?? '?'}% positivo`], sin_registro: ['', 'Sin registro (clienta nueva)'] }[o.hist_status] || ['', 'Aún sin revisar'];
  let extra = '';
  if (o.hist_status === 'bajo') {
    extra = o.prepaid_at ? `<span class="addr-reasons">Pagó por adelantado ${ago(o.prepaid_at)}</span><span class="addr-links"><button class="link-btn" data-prepaid="${esc(o.id)}" data-val="0">Deshacer</button></span>`
      : `<span class="addr-reasons">${o.prepay_requested_at ? `Se pidió transferencia ${ago(o.prepay_requested_at)}` : esc(o.prepay_error || 'Falta pedir transferencia')}</span>
         <span class="addr-links"><button class="link-btn" data-prepaid="${esc(o.id)}" data-val="1">Marcar pago recibido</button>${!o.prepay_requested_at ? `<button class="link-btn" data-askpay="${esc(o.id)}">Pedir transferencia</button>` : ''}</span>`;
  }
  return `<span class="addr-check ${h[0]}">${h[1]}</span>${o.hist_text && o.hist_status !== 'sin_registro' ? `<span class="addr-reasons">${esc(o.hist_text)}</span>` : ''}${extra}`;
}
$('#orderPane').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-prepaid]'), a = e.target.closest('[data-askpay]');
  if (!p && !a) return;
  try {
    if (p) { await api(`/api/orders/${encodeURIComponent(p.dataset.prepaid)}/prepaid`, { method: 'POST', body: { paid: p.dataset.val === '1' } }); toast(p.dataset.val === '1' ? 'Pago registrado' : 'Pago desmarcado'); }
    if (a) { await api(`/api/orders/${encodeURIComponent(a.dataset.askpay)}/request-prepay`, { method: 'POST' }); toast('Se pidió la transferencia'); }
  } catch (err) { toast(err.message); }
  loadConv(); loadList();
});
function verdictBlock(v) {
  if (!v) return '';
  const [cls, title] = VERDICT[v.verdict];
  const icon = (ok) => (ok === true ? '✓' : ok === false ? '✕' : '•');
  return `<section class="verdict ${cls}"><h3>${title}</h3><ul>${v.checks.map((c) => `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}"><span aria-hidden="true">${icon(c.ok)}</span>${esc(c.text)}</li>`).join('')}</ul></section>`;
}
$('#orderPane').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-recheck]'); if (!b) return;
  b.disabled = true; b.textContent = 'Validando…';
  try { const r = await api(`/api/orders/${encodeURIComponent(b.dataset.recheck)}/check-address`, { method: 'POST' }); toast((ADDR[r.status] || ['', r.status])[1].replace(/^[✓⚠✕] /, '')); }
  catch (err) { toast(err.message); }
  loadConv();
});

async function setOrderStatus(o, status) {
  const cancelInShopify = status === 'cancelled' && $('#cancelShopify')?.checked;
  if (cancelInShopify && !confirm(`¿Cancelar ${o.name} en Shopify? Esto no se puede deshacer.`)) return;
  try {
    const r = await api(`/api/orders/${encodeURIComponent(o.id)}/status`, { method: 'POST', body: { status, cancelInShopify, notify: $('#notify')?.checked } });
    toast(r.warnings?.length ? r.warnings.join(' ') : `${o.name}: ${STATUS[status].toLowerCase()}`);
    loadConv(); loadList();
  } catch (e) { toast(e.message); }
}

async function setBot(paused) {
  try { await api(`/api/conversations/${encodeURIComponent(state.current)}/bot`, { method: 'POST', body: { paused } }); toast(paused ? 'Bot pausado: respondes tú' : 'El bot vuelve a responder'); loadConv(); loadList(); }
  catch (e) { toast(e.message); }
}
$('#botToggle').addEventListener('change', (e) => setBot(!e.target.checked));

// respuesta manual
const reply = $('#replyText');
reply.addEventListener('input', () => { reply.style.height = 'auto'; reply.style.height = `${reply.scrollHeight}px`; });
reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = reply.value.trim(); if (!text) return;
  reply.value = ''; reply.style.height = 'auto';
  try { await api(`/api/conversations/${encodeURIComponent(state.current)}/send`, { method: 'POST', body: { text } }); }
  catch (err) { toast(err.message); }
  loadConv(true); loadList();
});

// simulador (demo)
$('#simulator').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#simText').value.trim(); if (!text) return;
  $('#simText').value = '';
  await simulate({ from: state.current, text });
});
$('#messages').addEventListener('click', (e) => {
  // En demo, tocar un botón de un mensaje lo "presiona" como cliente
  if (!state.status?.demo) return;
  const span = e.target.closest('.msg-buttons span'); if (!span) return;
  const title = span.textContent;
  const ids = { '✅ Confirmar': 'confirm', '❌ Cancelar': 'cancel_ask', '💬 Hablar con equipo': 'human', 'Sí, cancelar': 'cancel_yes', 'No, lo mantengo': 'keep' };
  const o = state.detail?.orders?.[0];
  if (ids[title] && o) simulate({ from: state.current, text: title, buttonId: `${ids[title]}:${o.id}` });
});
$('#newSimForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const from = $('#simPhone').value.replace(/\D/g, '');
  await simulate({ from, name: $('#simName').value, text: $('#simFirst').value });
  openConv(from);
});
async function simulate(body) {
  try { await api('/api/simulate', { method: 'POST', body }); } catch (e) { toast(e.message); }
  if (state.current) loadConv(true); loadList();
}

// ---------- métricas ----------
$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
  state.days = Number(b.dataset.days);
  $$('.segmented button').forEach((x) => x.classList.toggle('active', x === b));
  loadMetrics();
}));

async function loadMetrics() {
  const m = await api(`/api/metrics?days=${state.days}`);
  const resolved = m.confirmed + m.cancelled;
  const total = Math.max(m.orders, 1);
  const seg = (n, color) => (n ? `<span style="flex:${n};background:${color}"></span>` : '');
  $('#metricsBody').innerHTML = `
    <section class="hero-metric">
      <div>
        <div class="hero-number">${pct(m.confirmationRate)}</div>
        <div class="hero-label">de los pedidos respondidos fueron confirmados en los últimos ${m.days} días</div>
      </div>
      <div>
        <div class="ratio-bar" role="img" aria-label="${m.confirmed} confirmados, ${m.cancelled} cancelados, ${m.pending} sin respuesta">
          ${seg(m.confirmed, 'var(--chart-a)')}${seg(m.cancelled, 'var(--chart-b)')}${seg(m.pending, 'var(--line)')}
          ${!m.orders ? '<span style="flex:1;background:var(--line)"></span>' : ''}
        </div>
        <div class="ratio-legend">
          <span><i class="sw" style="background:var(--chart-a)"></i>${plural(m.confirmed, 'confirmado', 'confirmados')}</span>
          <span><i class="sw" style="background:var(--chart-b)"></i>${plural(m.cancelled, 'cancelado', 'cancelados')}</span>
          <span><i class="sw" style="background:var(--line)"></i>${m.pending} sin respuesta</span>
        </div>
      </div>
    </section>
    <section class="stats">
      ${stat(m.orders, 'Pedidos con conversación', `${pct(m.responseRate)} ya respondidos`)}
      ${stat(m.silentOrders, 'Pedidos sin mensaje', m.shopOrders ? `${pct(m.messageRate)} de ${m.shopOrders} pedidos escribió. ${plural(m.remindersSent, 'recordatorio', 'recordatorios')}` : 'Se calcula al conectar Shopify')}
      ${stat(money(m.confirmedAmount, m.currency || 'CLP'), 'Monto confirmado', `${money(m.cancelledAmount, m.currency || 'CLP')} cancelado`)}
      ${stat(dur(m.medianResponseSecs), 'Tiempo de respuesta', `Mediana. Equipo: ${dur(m.medianHumanResponseSecs)}`)}
      ${stat(m.medianTimeToConfirmMin == null ? '—' : dur(m.medianTimeToConfirmMin * 60), 'Hasta confirmar', 'Desde que el cliente escribe')}
      ${stat(pct(m.autoResolvedShare), 'Resueltos sin intervención', `${pct(m.automationShare)} de los mensajes los envió el bot`)}
      ${stat(m.needsHuman, 'Esperan a una persona', `${m.conversations} conversaciones en el periodo`)}
    </section>
    ${chartCard('Confirmados y cancelados por día', 'Según el día en que se resolvió cada pedido.', m.series, [['confirmed', 'Confirmados', 'var(--chart-a)'], ['cancelled', 'Cancelados', 'var(--chart-b)']], true)}
    ${chartCard('Mensajes recibidos por día', 'Mensajes que escribieron los clientes.', m.series, [['inbound', 'Mensajes recibidos', 'var(--chart-c)']], false)}`;
  bindChartHover();
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const stat = (v, label, sub) => `<div class="stat"><div class="stat-value">${esc(v)}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;

function chartCard(title, sub, series, keys, stacked) {
  const W = Math.max(300, Math.round(($('#metricsBody').clientWidth || 760) - 46)), H = W < 500 ? 200 : 240, pad = { l: 34, r: 8, t: 8, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const totals = series.map((d) => (stacked ? keys.reduce((a, [k]) => a + d[k], 0) : Math.max(...keys.map(([k]) => d[k]))));
  const max = niceMax(Math.max(1, ...totals));
  const ticks = [0, max / 2, max];
  const step = iw / series.length;
  const bw = Math.max(3, Math.min(28, step * 0.62));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const labelEvery = Math.ceil(series.length / Math.max(3, Math.floor(W / 90)));
  const cols = series.map((d, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    let acc = 0;
    const rects = keys.map(([k, , color], j) => {
      const v = d[k]; if (!v) return '';
      const y0 = y(acc), y1 = y(acc + v); acc += v;
      const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
      const top = j === keys.filter(([kk]) => d[kk]).length - 1;
      return top ? `<path d="${roundTop(x, y1, bw, h, 3)}" fill="${color}"/>` : `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" fill="${color}"/>`;
    }).join('');
    const tip = esc(JSON.stringify({ day: d.day, rows: keys.map(([k, n, c]) => [n, d[k], c]) }));
    return `<g class="col"><rect class="hit" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${ih}" data-tip="${tip}"/>${rects}</g>`;
  }).join('');
  const xLabels = series.map((d, i) => (i % labelEvery === 0 || i === series.length - 1)
    ? `<text x="${pad.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${shortDay(d.day)}</text>` : '').join('');
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const yLabels = ticks.map((t) => `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  const legend = keys.length > 1 ? `<div class="chart-legend">${keys.map(([, n, c]) => `<span><i class="sw" style="background:${c}"></i>${n}</span>`).join('')}</div>` : '';
  const table = `<details class="table-toggle"><summary>Ver como tabla</summary><table class="data-table"><thead><tr><th>Día</th>${keys.map(([, n]) => `<th>${n}</th>`).join('')}</tr></thead><tbody>${series.map((d) => `<tr><td>${shortDay(d.day)}</td>${keys.map(([k]) => `<td>${d[k]}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
  return `<section class="chart-card"><h2>${esc(title)}</h2><p class="chart-sub">${esc(sub)}</p>${legend}
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><g class="grid">${grid}</g><g class="axis">${yLabels}${xLabels}</g>${cols}</svg></div>${table}</section>`;
}
const roundTop = (x, y, w, h, r) => { r = Math.min(r, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p; };
const shortDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };

function bindChartHover() {
  const tip = $('#tooltip');
  $$('.chart .hit').forEach((r) => {
    r.addEventListener('mousemove', (e) => {
      const d = JSON.parse(r.dataset.tip);
      tip.innerHTML = `<strong>${shortDay(d.day)}</strong><br>${d.rows.map(([n, v, c]) => `<i class="sw" style="background:${c}"></i>${n}: ${v}`).join('<br>')}`;
      tip.hidden = false;
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
    });
    r.addEventListener('mouseleave', () => (tip.hidden = true));
  });
}

// ---------- arranque y actualización periódica ----------
let timers = [];
async function start() {
  try { state.status = await api('/api/status'); } catch { return; }
  $('#login').hidden = true; $('#app').hidden = false;
  renderHealth(state.status);
  await loadList();
  loadSilent().catch(() => {});
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => { if (!document.hidden) loadList().catch(() => {}); }, 5000),
    setInterval(() => { if (!document.hidden && state.current && state.view === 'inbox') loadConv().catch(() => {}); }, 3000),
    setInterval(() => { if (!document.hidden && state.view === 'metrics') loadMetrics().catch(() => {}); }, 30000),
    setInterval(() => { if (!document.hidden) loadSilent().catch(() => {}); }, 30000),
  ];
}
start();
let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (state.view === 'metrics') loadMetrics().catch(() => {}); }, 250); });
