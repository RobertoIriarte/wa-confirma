# WhatsApp Confirma

Agente de WhatsApp que confirma los pedidos de tu tienda Shopify, con un panel para ver las conversaciones, responder tú mismo y revisar métricas.

## Cómo funciona

1. La clienta termina su compra en el formulario de Releasit, que la lleva directo a WhatsApp con un mensaje ya escrito hacia tu número, con el número de pedido, los productos, el total, la dirección y la frase "Confirmo mi pedido y mis datos están correctos".
2. El agente busca el pedido por ese número (o por el teléfono, si no viene). Si todavía no aparece en Shopify, vuelve a buscar a los 8 y a los 20 segundos.
3. **Si el mensaje es la confirmación de Releasit**, compara la dirección y el total del mensaje con el pedido en Shopify, y **busca la dirección en Google Maps** (que la calle exista, que el número calce y que quede en esa comuna):
   - Si todo coincide, confirma el pedido y le agradece. No le pide nada más.
   - Si Google no encuentra la dirección o queda dudosa, no confirma: le pide a la clienta su ubicación 📍 o la dirección completa, y el chat queda en "Dirección por revisar" con el motivo, lo que sugiere Google y el enlace al mapa.
   - Si no coinciden (la clienta puede editar el texto antes de enviarlo, por ejemplo para corregir la dirección), no confirma: le avisa que una persona revisará sus datos y el chat queda marcado arriba en el panel con las dos direcciones o totales para comparar.
4. Si escribe sin el mensaje de Releasit, le responde con el resumen del pedido y tres botones: **Confirmar**, **Cancelar** y **Hablar con alguien**. Cancelar pide una segunda confirmación.
5. Si escribe texto libre ("sí", "¿cuánto demora?", "me equivoqué de dirección"), responde la IA. Las respuestas simples como "sí" o "confirmo" se resuelven sin gastar IA.
6. Lo que el agente no puede resolver (cambios de dirección, reclamos, pagos, dudas que no están en tu información) lo deriva a una persona: el bot se pausa en ese chat y queda marcado arriba de la bandeja.
7. En Shopify, cada pedido queda con la etiqueta `WA-CONFIRMADO`, `WA-CANCELADO` o `WA-REVISAR`. Así puedes filtrar en Pedidos qué despachar.

> Tus pedidos de Releasit se envían a Dropi al crearse (etiqueta "Order sent to dropi"). Este sistema no toca Dropi: si una clienta cancela o corrige su dirección por WhatsApp, también hay que actualizarlo en Dropi antes de que se despache.

### Historial de la clienta (regla del 70%)

Cada hora (9:00 a 22:00) una revisión programada en Claude consulta en Dropi el historial de las clientas con pedidos nuevos y lo deja escrito en el pedido de Shopify: etiqueta `HIST-OK`, `HIST-BAJO` o `HIST-SIN-REGISTRO`, más una nota *"Historial Dropi: 85% positivo (entregas 80%, devoluciones 14%)"*. Positivo = entregados ÷ (entregados + devueltos); los pedidos en tránsito no cuentan.

- **70% o más, o sin registro** (clienta nueva): pasa.
- **Bajo 70%**: la clienta no se entera. Recibe el mismo mensaje neutro de siempre (*"Recibimos la confirmación de su pedido… ahora lo preparamos para el despacho"*) y el pedido queda marcado en el panel como **"Historial bajo: decidir si se despacha"**, con la etiqueta `WA-REVISAR` en Shopify. Tú decides si lo llamas, lo cancelas o tocas **Aprobar despacho igual**. (Con `HISTORY_LOW_ACTION=prepay` el agente pide transferencia en su lugar.)
- Mientras el historial no se haya revisado, el pedido no aparece como "listo".

El servidor lee el historial desde Shopify porque el acceso a Dropi está en tu cuenta de Claude, no en el servidor. Si más adelante consigues un token de la API de Dropi, se puede consultar directo.

### Pedidos que no envían el mensaje

La clienta puede cerrar WhatsApp sin enviar el mensaje, aunque el pedido ya esté creado. Por eso el sistema lee los pedidos de Shopify cada 2 minutos y, si uno lleva más de 15 minutos sin conversación, aparece en la sección **Sin mensaje** del panel con su teléfono y botones para llamar, abrir el pedido en Shopify o descartarlo.

Opcionalmente, a los 30 minutos se le envía un **recordatorio por WhatsApp** con botones Confirmar / Cancelar. Como en ese caso escribes tú primero, WhatsApp exige una plantilla aprobada por Meta (paso 3b). Se envía una sola vez por pedido, nunca entre las 22:00 y las 9:00 (queda para la mañana) y solo para pedidos creados después de activar el sistema, así que no le escribe a clientas antiguas. Si la clienta toca un botón o responde, sigue el mismo flujo de confirmación.

Por seguridad, si alguien escribe el número de un pedido desde un teléfono distinto al de la compra, el bot no muestra nombre, dirección ni productos, y las cancelaciones pasan a una persona.

## El panel

Cada pedido muestra un **veredicto para Dropi** con sus razones: *Listo para confirmar*, *Revisar antes de confirmar*, *Esperando que la clienta confirme* o *No despachar*. Revisa si confirmó por WhatsApp, su historial en Dropi (mínimo 70%), si la dirección se encontró en Google Maps, si el WhatsApp coincide con el teléfono del pedido y si tiene otros pedidos abiertos esa semana. El filtro **Listos para Dropi** te deja la lista para entrar a Dropi y confirmarlos.

- **Conversaciones**: todos los chats, con filtros (requieren atención, pendientes, confirmados, cancelados, sin pedido) y búsqueda. Al lado, la boleta del pedido con su estado.
- **Responder a mano**: al escribir desde el panel el bot se pausa en ese chat. "Devolver al bot" lo reactiva. WhatsApp solo permite texto libre durante 24 horas desde el último mensaje del cliente; el panel te avisa cuando la ventana está cerrada.
- **Acciones del pedido**: confirmar, cancelar (opcionalmente también en Shopify), volver a pendiente, reenviar el resumen con botones o vincular un pedido a mano.
- **Sin mensaje**: pedidos que no escribieron, con llamar, enviar recordatorio, ver en Shopify y descartar.
- **Métricas** (7, 30 o 90 días): porcentaje de clientas que envían el mensaje, tasa de confirmación, pedidos sin respuesta, monto confirmado y cancelado, tiempo de respuesta, tiempo hasta confirmar, porcentaje resuelto sin intervención y gráficos por día.

## Probarlo sin conectar nada

Necesitas Node 22.13 o superior. No hay dependencias que instalar.

```bash
DEMO=true DATA_DIR=./data-demo node scripts/seed-demo.js   # opcional: llena el panel con datos de ejemplo
npm run demo                                               # abre http://localhost:3000
```

En modo demo no se envía nada a WhatsApp, se usan los pedidos de ejemplo #1001 y #1002, y abajo del chat aparece un cuadro para escribir como si fueras la clienta (también puedes tocar los botones de los mensajes).

## Puesta en marcha

### 1. Subir el código a GitHub
Crea un repositorio privado y sube esta carpeta.

### 2. Desplegar en Railway
1. En [railway.com](https://railway.com) crea un proyecto con **Deploy from GitHub repo** y elige el repositorio.
2. En el servicio, **Settings > Volumes**: agrega un volumen montado en `/data` (ahí vive la base de datos; sin volumen se borra en cada despliegue).
3. **Settings > Networking > Generate Domain**. Anota la dirección, por ejemplo `https://wa-confirma.up.railway.app`.
4. **Variables**: copia las de `.env.example` y completa las que tengas. Mínimo para arrancar: `DATA_DIR=/data`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `STORE_NAME` y `STORE_INFO`.

> `STORE_INFO` es lo único que el agente sabe de tu tienda. Escribe ahí tus plazos, formas de pago y políticas reales; el ejemplo de `.env.example` es inventado. Lo que no esté ahí, el agente lo deriva a una persona en vez de inventarlo.

### 3. WhatsApp (Meta)
1. En [developers.facebook.com](https://developers.facebook.com) crea una app de tipo **Business** y agrégale el producto **WhatsApp**.
2. En **WhatsApp > Configuración de la API** agrega tu número de teléfono y verifícalo. Copia el **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`. El número no puede estar usándose al mismo tiempo en la app normal de WhatsApp.
3. Token permanente: en el **Business Manager > Configuración > Usuarios del sistema**, crea un usuario del sistema administrador, asígnale la app y genera un token con los permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WHATSAPP_TOKEN`. (El token temporal de la página de prueba vence en 24 horas.)
4. **Configuración de la app > Básica > Clave secreta de la app** → `META_APP_SECRET`.
5. **WhatsApp > Configuración > Webhook**:
   - URL de devolución de llamada: `https://TU-DOMINIO/webhook`
   - Token de verificación: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
   - Guarda y suscríbete al campo **messages**.
6. Publica la app (modo **Activo**) para recibir mensajes de cualquier cliente, no solo de los números de prueba.

### 3b. Plantilla del recordatorio (opcional)
1. En el **WhatsApp Manager > Plantillas de mensajes**, crea una plantilla nueva:
   - Categoría: **Utilidad** (es una actualización de un pedido, no publicidad).
   - Nombre: `confirmar_pedido` (o el que quieras). Idioma: **Español**.
   - Cuerpo, por ejemplo: `Hola {{1}}, recibimos tu pedido {{2}} por {{3}} en Her Essence. ¿Nos confirmas para despacharlo?`
   - Botones de respuesta rápida, en este orden: **Confirmar** y **Cancelar**.
2. Espera la aprobación (suele tardar minutos u horas).
3. Pon el nombre en `REMINDER_TEMPLATE`. Si tu cuerpo usa otras variables, ajusta `REMINDER_TEMPLATE_PARAMS` (por ejemplo `nombre,pedido` si solo tiene `{{1}}` y `{{2}}`).

Cada plantilla de utilidad enviada tiene un costo según la tabla de precios de Meta para Chile. Las respuestas dentro de las 24 horas siguientes no cobran plantilla.

### 4. Shopify
Desde enero de 2026 las apps propias se crean en el Dev Dashboard:
1. En el admin de Shopify, **Configuración > Apps > Desarrollar apps** te lleva al **Dev Dashboard**. Crea una app.
2. En **Versiones**, da los permisos `read_orders`, `write_orders` y `read_customers`, y publica la versión.
3. Instala la app en tu tienda.
4. En **Configuración** de la app copia **Client ID** y **Client secret** → `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET`. `SHOPIFY_STORE_DOMAIN` es tu dominio `algo.myshopify.com` (no el dominio .cl).

El sistema pide y renueva solo el token de acceso (dura 24 horas).

### 5. Botón "Confirmar por WhatsApp" en el correo
En Shopify, **Configuración > Notificaciones > Confirmación de pedido > Editar código**, agrega donde quieras que aparezca (cambia el número por el tuyo, sin `+` ni espacios):

```liquid
<p style="text-align:center;margin:24px 0">
  <a href="https://wa.me/56912345678?text=Hola%2C%20quiero%20confirmar%20mi%20pedido%20{{ order.name | url_encode }}"
     style="background:#25D366;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">
    Confirmar mi pedido por WhatsApp
  </a>
</p>
```

Puedes poner el mismo enlace en la página de gracias con un bloque de texto o botón desde el editor de checkout.

### 5b. Google Maps (validación de direcciones)
1. En [console.cloud.google.com](https://console.cloud.google.com) crea un proyecto y activa la facturación (Google la exige aunque no llegues a pagar).
2. En **APIs y servicios > Biblioteca**, habilita **Geocoding API**.
3. En **Credenciales**, crea una clave de API y restríngela solo a Geocoding API → `GOOGLE_MAPS_API_KEY`.

Google incluye 10.000 consultas gratis al mes para Geocoding, y el agente consulta una vez por pedido, así que con tu volumen no deberías pagar. Si Google falla o la clave está mal, la dirección queda "sin validar" y no se bloquea ningún pedido.

### 6. IA (OpenAI o Claude)
Basta una de las dos. Con OpenAI: crea una clave en [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → `OPENAI_API_KEY` (modelo por defecto `gpt-5-mini`, se cambia con `OPENAI_MODEL`). Con Claude: clave de [console.anthropic.com](https://console.anthropic.com) → `ANTHROPIC_API_KEY`. Sin ninguna, el bot funciona solo con botones y respuestas fijas.

### 7. Probar
Abre `https://TU-DOMINIO`, entra con tu contraseña y revisa que en la barra lateral WhatsApp, Shopify e IA aparezcan conectados. Escríbele a tu número desde otro teléfono con el número de un pedido real.

## Costos aproximados
- Railway: desde unos US$5 al mes.
- WhatsApp: si el cliente escribe primero, las respuestas dentro de 24 horas no tienen costo de plantilla según las reglas actuales de Meta; revisa la tabla vigente en la documentación de precios de WhatsApp Business.
- IA: pocos pesos por conversación con Haiku; solo se usa para texto libre.

## Archivos
```
src/server.js     servidor, webhook de Meta y API del panel
src/agent.js      lógica del agente (botones, IA, derivación)
src/whatsapp.js   envío de mensajes por la API de WhatsApp Cloud
src/shopify.js    búsqueda de pedidos, etiquetas y cancelación
src/orders.js     cambios de estado de pedidos
src/reminders.js  pedidos sin mensaje: sincronización y recordatorios
src/address.js    validación de direcciones con Google Maps
src/history.js    lectura del historial de la clienta (etiquetas y nota en Shopify)
src/db.js         base SQLite y métricas
public/           panel web
scripts/seed-demo.js  datos de ejemplo
```
