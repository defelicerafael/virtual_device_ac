# Rediseño com.panteasmart.devices

Documento vivo del rediseño desde cero de la app. Acá se registra todo lo que se aprende, se define y se decide. Ver [estado-rediseno.md](estado-rediseno.md) para el punto de entrada de cada sesión.

## Objetivo

App de Homey que permite dar de alta tantos devices como el usuario quiera; cada device es un aire acondicionado virtual con su configuración propia. Homey → webhook HA → Broadlink IR.

**Requisito clave:** el botón on/off debe activar/desactivar el termostato **igual a la última vez que estuvo prendido**.

## Cómo funciona la app actual (relevada 2026-07-13)

- Un solo driver `virtual_ac`, class `thermostat`.
- Capabilities: `onoff`, `target_temperature` (16–30°C paso 1), `measure_temperature`, `thermostat_mode`, `learning_mode` (botón), `swing_on_off`, `sleep_on_off`.
- Cada cambio de capability arma un **payload completo** y lo POSTea a HA:
  ```json
  {
    "remote_entity": "remote.<remote_entity_name>",
    "device": "<codigo_ac>",        // ej. "ac1"
    "hvac_mode": "cool",
    "sleep": "on|off",
    "swing": "on|off",
    "temperature": 24,
    "onoff": true
  }
  ```
  a `http://<ha_ip>:<ha_port>/api/webhook/ac_command` (o `ac_learn` si está el modo aprendizaje).
- **On/off actual (parcial):** guarda solo el *modo* en store (`last_mode`) y lo restaura al prender. Temperatura/swing/sleep no son snapshot: se manda el valor actual de las capabilities.
- **Auto-on:** setting `auto_on_temp_change` — al mover la temperatura estando apagado, prende en el último modo (o `cool`).
- Flag `_fromOnOffUpdate` para evitar doble envío entre los listeners de `onoff` y `thermostat_mode`.
- **Pairing:** alta automática con contador global (`Pantea Virtual AC N`), settings por defecto: `ha_ip: panteasmart.local`, `remote_entity_name: pantea_ac_N`, `codigo_ac: ac1` (fijo, NO incrementa), `ha_port: 8123`.
- Settings por device: `ha_ip`, `ha_port`, `remote_entity_name`, `codigo_ac`, `auto_on_temp_change`.
- Del lado HA: patrón scripts+webhooks `ac_*` (HA fatato 192.168.68.60, Broadlink RM4 Pro).

## Problemas encontrados en la app actual

1. **El build no coincide con la intención.** Config de driver duplicada en `.homeycompose/app.json` (Compose la IGNORA para drivers) y en `driver.compose.json` (lo que vale). El `app.json` compilado no tiene los modos `dry`/`fan` ni el setting `ha_port` declarado. El termostato real solo ofrece auto/heat/cool/off.
2. **Sin feedback de errores:** si el webhook falla solo se loguea; la UI queda mostrando un estado que nunca llegó al aire.
3. **Sin retorno HA→Homey:** hay listener sobre `measure_temperature` pero nada la actualiza. 100% unidireccional.
4. **`fan_mode` (velocidad) comentado** en el código — empezado y abandonado.
5. Menores: sleep/swing definidas como `button` en `.homeycompose/capabilities/` pero `toggle` en otro lado; `package.json` dice `com.company.myapp`; autor Rafael Defelice; contador de pairing nunca decrementa.

## Definiciones tomadas

1. **On/off (2026-07-13).** Al prender: se restaura el **último modo** en que estuvo prendido, pero la **temperatura vigente del tile gana** — si alguien movió la temperatura estando apagado (con auto-on deshabilitado), al prender se usa esa temperatura nueva, no la del momento de apagar. `auto_on_temp_change` sigue existiendo como opción por device.
2. **Modos y velocidad (2026-07-13).** Se agregan los modos `dry` y `fan` (queda: off/auto/heat/cool/dry/fan) y la capability `fan_mode` (velocidad). En la config del tile habrá una opción "tiene fan_mode aprendido": si NO lo tiene, se envía siempre `auto` (comportamiento actual de todos los equipos). Nota del script: los tiles actuales usan picker **auto/low/medium/high/turbo** — confirmar si `turbo` entra en la nueva app.
3. **Pairing (2026-07-13).** Solo el **instalador** da de alta los equipos → se hace un **wizard de pairing con vistas custom** (cargar la config antes de crear el device, en vez de alta automática + corregir settings). `codigo_ac` deja de ser configurable: **siempre "ac1"**, porque ahora al device se le puede poner directamente el código con el que va a buscar el comando al webservice del Google Spreadsheet.
4. **Requisito nuevo — lógica del HomeyScript "PS Broadlink" (2026-07-13).** Como la app no funcionaba bien, hoy el trabajo real lo hace un HomeyScript en el Homey Pro de ferno "San Fran". Fernán pasó el código: copia en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis completo en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Es **indispensable** que la nueva app incorpore esa funcionalidad, en particular el lookup de comandos IR contra el webservice del Google Spreadsheet (`?code={code}` → filas `{mode, fan, temp, sleep, irCommand}`), el cache, el payload `command_code` con fallback legacy, y la secuencia "modo/ON separado". **Hallazgo clave:** en producción hoy los tiles son devices de la app Device Capabilities + Flows + este script — la nueva app reemplaza a los tres.

5. **Swing y sleep (2026-07-13).** Se modelan distinto:
   - **Swing:** comando separado con **códigos on/off** (filas `swing_on`/`swing_off` en la planilla). Si el aire tiene un solo código toggle, se repite el mismo código en ambas filas. En Homey: toggle con estado.
   - **Sleep:** sigue **dentro de la clave compuesta** `{modo}_{fan}_{temp}_{sleep}` — es parte del código que se envía junto con la temperatura, como hoy. En Homey: toggle con estado; al cambiarlo se reenvía el comando completo.
   - **Al prender (2026-07-13):** swing y sleep conservan lo vigente en el tile (misma regla que la temperatura). Sleep va implícito en el comando completo de encendido. Para swing: comparar los códigos `swing_on` y `swing_off` de ese aire — si son **diferentes**, después de mandar el encendido se manda el código de swing correspondiente al estado del tile; si son **iguales** (toggle), no se manda nada (no se puede saber el estado real del equipo).

6. **Branding — HA invisible (2026-07-13).** El usuario nunca debe enterarse de que de fondo hay un Home Assistant. En TODOS los textos visibles de la app (wizard de pairing, settings, mensajes de error, nombres de campos) se habla de **"Pantea Home Manager"**: el campo de conexión es "Host/IP de Pantea Home Manager", nunca "Home Assistant IP" como hoy. Aplica la regla general de arquitectura de producto Pantea (Homey es la cara al cliente, HA oculto detrás).

## Preguntas abiertas
4. **Campos del wizard de pairing.** ¿Qué carga exactamente el instalador: host/IP de Pantea Home Manager (+puerto), entidad remote, nombre del device, el código del spreadsheet, auto-on, "tiene fan_mode aprendido", "modo/ON separado"? ¿Y cómo es ese "código del spreadsheet" — un identificador de marca/modelo de AC? ¿Ejemplo real? ¿Reemplaza conceptualmente a `codigo_ac` (que queda fijo "ac1" solo por compatibilidad con el lado servidor)?
5. **Retorno HA→Homey.** ¿Incluir vía de vuelta (temperatura ambiente real, confirmación de envío IR) vía endpoint API de la app? ¿O unidireccional y se elimina `measure_temperature`?
6. **Manejo de errores.** Si HA no responde: ¿(a) revertir capability en UI, (b) warning/unavailable en el device, (c) reintentos? Combinables.
7. **Botón Learning.** ¿Visible en el device o maintenance action en settings avanzados? ¿Cómo es el flujo `ac_learn` del lado HA?
8. **Alcance.** ¿Estructura pensada para más tipos de device virtual a futuro o app "de los AC"? ¿Flow cards (hoy no hay ninguna)?
9. ~~HomeyScript "PS Broadlink" (falta el código)~~ → RESUELTO: código en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Del análisis salen las preguntas 10–15.
10. **Swing.** PARCIALMENTE RESUELTO (ver definición 5): swing va como comando separado con códigos on/off (filas `swing_on`/`swing_off` en la planilla — el formato actual ya soporta filas sin temp indexadas por modo). Queda pendiente: confirmar que hoy efectivamente no se envía nunca (el script lo lee pero no lo pone en el payload) y que los flows/planilla actuales no lo cubren por otro lado.
11. **Fallback legacy.** Cuando la planilla no tiene el comando, se manda el payload viejo (`device: "ac1"`, hvac_mode, etc.) para que HA lo resuelva con códigos aprendidos vía `ac_learn`. ¿Ese camino tiene que seguir vivo en la nueva app, o el objetivo es que todo vaya por planilla (`command_code`) y el legacy es transitorio?
12. **Learning.** Hoy es un botón GLOBAL ("Aprender AC", device aparte): activado, el próximo comando de cualquier aire va a `ac_learn`. ¿En la nueva app pasa a ser por device (botón/maintenance action en cada AC) o se mantiene global?
13. **"Modo/ON separado"** (`modeOnDevices`, hoy lista hardcodeada). ¿Pasa a ser una opción por device en el wizard? ¿El wait de 2s entre comando de modo y comando completo está bien fijo o configurable?
14. **Cache de comandos IR.** Hoy: variable global de Homey, se invalida editando el script (`limpiarCache`). En la nueva app, ¿alcanza con cachear en memoria/store y un botón "recargar códigos" (maintenance action) para cuando se actualiza la planilla?
15. **Planilla / webservice.** ¿Quién la mantiene y cómo se cargan los códigos (a mano desde capturas del Broadlink?)? ¿El `code` es un identificador de marca/modelo? ¿Ejemplo real de code y de filas? ¿La URL del Apps Script es estable o conviene que sea configurable a nivel app?
