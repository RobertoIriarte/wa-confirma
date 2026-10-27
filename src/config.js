// Configuración leída desde variables de entorno (ver .env.example)
const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase()));

export const config = {
  port: Number(env.PORT || 3000),
  dataDir: env.DATA_DIR || './data',

  // Si DEMO=true el sistema funciona sin Meta ni Shopify: no envía mensajes reales
  // y usa pedidos de ejemplo. Sirve para probar el panel antes de conectar todo.
  demo: bool(env.DEMO),

  store: {
    name: env.STORE_NAME || 'Mi tienda',
    // Información que el agente puede usar para responder (plazos, políticas, horarios...)
    info: env.STORE_INFO || '',
    timezone: env.TIMEZONE || 'America/Santiago',
  },

  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    reopenTemplate: env.REOPEN_TEMPLATE ?? 'retomar_conversacion', // plantilla para escribir pasadas 24 h (variable {{1}} = nombre)
    appSecret: env.META_APP_SECRET || '',
    graphVersion: env.GRAPH_API_VERSION || 'v23.0',
  },

  shopify: {
    domain: (env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    clientId: env.SHOPIFY_CLIENT_ID || '',
    clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
    accessToken: env.SHOPIFY_ACCESS_TOKEN || '', // solo si tienes una app "legacy" con token fijo
    apiVersion: env.SHOPIFY_API_VERSION || '2026-04',
    lookbackDays: Number(env.ORDER_LOOKBACK_DAYS || 10),
    autoCancel: bool(env.AUTO_CANCEL_IN_SHOPIFY, false),
    // Esperas (segundos) para reintentar la búsqueda si el pedido aún no aparece en Shopify
    retrySeconds: (env.ORDER_RETRY_SECONDS ?? (bool(env.DEMO) ? '' : '8,20')).split(',').map(Number).filter((n) => n > 0),
    tags: {
      confirmed: env.TAG_CONFIRMED || 'WA-CONFIRMADO',
      cancelled: env.TAG_CANCELLED || 'WA-CANCELADO',
      review: env.TAG_REVIEW || 'WA-REVISAR',
      prepay: env.TAG_PREPAY || 'PAGO-ADELANTADO',
    },
  },

  // Pedidos que terminan la compra pero no envían el mensaje de WhatsApp
  sync: {
    everyMinutes: Number(env.ORDER_SYNC_MINUTES || 2), // cada cuánto leer pedidos nuevos de Shopify
    days: Number(env.ORDER_SYNC_DAYS || 3),            // ventana de pedidos a revisar
  },
  reminders: {
    graceMinutes: Number(env.SILENT_AFTER_MINUTES || 15), // desde cuándo un pedido cuenta como "sin mensaje"
    template: env.REMINDER_TEMPLATE || '',             // nombre de la plantilla aprobada en Meta; vacío = no enviar
    language: env.REMINDER_TEMPLATE_LANG || 'es',
    afterMinutes: Number(env.REMINDER_AFTER_MINUTES || 30),
    quietHours: env.REMINDER_QUIET_HOURS || '22-9',    // no enviar entre las 22:00 y las 9:00
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '56',
  },

  // Historial de la clienta (Dropi): mínimo % de pedidos entregados entre los finalizados
  history: {
    minRate: Number(env.HISTORY_MIN_RATE || 70),
    // Qué hacer si está bajo el mínimo: 'review' = solo se marca para revisión interna (la clienta no se entera)
    //                                     'prepay' = se le pide transferencia antes del despacho
    lowAction: (env.HISTORY_LOW_ACTION || 'review').toLowerCase(),
    // Disparo inmediato de la revisión de historial (tarea programada de Claude con disparador por API)
    fireUrl: env.HISTORY_ROUTINE_URL || '',
    fireToken: env.HISTORY_ROUTINE_TOKEN || '',
    fireMinGapSeconds: Number(env.HISTORY_FIRE_MIN_GAP || 120), // no disparar más de una vez cada 2 min (la tarea revisa todos los pendientes)
    prepayInfo: (env.PREPAY_INFO || '').replace(/\\n/g, '\n'),
  },

  // Avisos de envío a la clienta (estado escrito por la tarea "Estado de envío Dropi → Shopify")
  shipping: {
    notify: (env.SHIP_NOTIFY ?? 'en_transito,en_reparto,novedad,entregado').split(',').map((s) => s.trim()).filter(Boolean),
    freshHours: Number(env.SHIP_FRESH_HOURS || 12), // no avisar estados más antiguos que esto (evita avisos atrasados)
    // Plantillas de Meta para avisar pasadas las 24 h (vacío = solo se avisa si la ventana de 24 h está abierta)
    templates: { en_transito: env.SHIP_TEMPLATE_EN_TRANSITO || '', en_transito_rm: env.SHIP_TEMPLATE_EN_TRANSITO_RM || '', en_reparto: env.SHIP_TEMPLATE_EN_REPARTO || '', novedad: env.SHIP_TEMPLATE_NOVEDAD || '', entregado: env.SHIP_TEMPLATE_ENTREGADO ?? 'envio_entregado' },
    templateParams: { en_transito: env.SHIP_TEMPLATE_EN_TRANSITO_PARAMS, en_transito_rm: env.SHIP_TEMPLATE_EN_TRANSITO_RM_PARAMS, en_reparto: env.SHIP_TEMPLATE_EN_REPARTO_PARAMS, novedad: env.SHIP_TEMPLATE_NOVEDAD_PARAMS || 'nombre,pedido,transportista', entregado: env.SHIP_TEMPLATE_ENTREGADO_PARAMS || 'nombre,pedido' },
  },

  maps: {
    apiKey: env.GOOGLE_MAPS_API_KEY || '',
    country: env.ADDRESS_COUNTRY || 'CL',
    // true = si la dirección no se encuentra o es dudosa, el agente NO confirma y pide la ubicación
    blockOnDoubt: !['0', 'false', 'no'].includes(String(env.ADDRESS_BLOCK_ON_DOUBT || 'true').toLowerCase()),
  },

  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1', // transcripción de audios (requiere OPENAI_API_KEY)
    // openai | anthropic. Por defecto: el que tenga clave (si están ambas, OpenAI)
    provider: (env.AI_PROVIDER || (env.OPENAI_API_KEY ? 'openai' : 'anthropic')).toLowerCase(),
    historyMessages: Number(env.AI_HISTORY_MESSAGES || 20),
  },

  dashboard: {
    password: env.DASHBOARD_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || env.DASHBOARD_PASSWORD || 'cambia-esto',
  },
};

export const whatsappReady = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
export const shopifyReady = () =>
  Boolean(config.shopify.domain && (config.shopify.accessToken || (config.shopify.clientId && config.shopify.clientSecret)));
export const aiReady = () => Boolean(config.ai.provider === 'openai' ? config.ai.openaiKey : config.ai.apiKey);
export const aiModelName = () => (config.ai.provider === 'openai' ? `OpenAI ${config.ai.openaiModel}` : config.ai.model);
