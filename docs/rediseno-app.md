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
2. **Modos y velocidad (2026-07-13).** Se agregan los modos `dry` y `fan` (queda: off/auto/heat/cool/dry/fan) y la capability `fan_mode` (velocidad, con turbo — ver definición 11). En la config del tile habrá una opción "tiene fan_mode aprendido": si NO lo tiene, se envía siempre `auto` (comportamiento actual de todos los equipos).
3. **Pairing (2026-07-13).** Solo el **instalador** da de alta los equipos → se hace un **wizard de pairing con vistas custom** (cargar la config antes de crear el device, en vez de alta automática + corregir settings). `codigo_ac` deja de ser configurable: **siempre "ac1"**, porque ahora al device se le puede poner directamente el código con el que va a buscar el comando al webservice del Google Spreadsheet.
4. **Requisito nuevo — lógica del HomeyScript "PS Broadlink" (2026-07-13).** Como la app no funcionaba bien, hoy el trabajo real lo hace un HomeyScript en el Homey Pro de ferno "San Fran". Fernán pasó el código: copia en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis completo en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Es **indispensable** que la nueva app incorpore esa funcionalidad, en particular el lookup de comandos IR contra el webservice del Google Spreadsheet (`?code={code}` → filas `{mode, fan, temp, sleep, irCommand}`), el cache, el payload `command_code` con fallback legacy, y la secuencia "modo/ON separado". **Hallazgo clave:** en producción hoy los tiles son devices de la app Device Capabilities + Flows + este script — la nueva app reemplaza a los tres.

5. **Swing y sleep (2026-07-13).** Se modelan distinto:
   - **Swing:** comando separado con **códigos on/off**. En la planilla van como filas con `mode = "swing_on"` / `mode = "swing_off"` (sin temp) — **sin columnas nuevas**, el formato actual las indexa por modo solo y el Apps Script no se toca (confirmado por Fernán 2026-07-13). Si el aire tiene un solo código toggle, se repite el mismo código en ambas filas. En Homey: toggle con estado.
   - **Sleep:** sigue **dentro de la clave compuesta** `{modo}_{fan}_{temp}_{sleep}` — es parte del código que se envía junto con la temperatura, como hoy. En Homey: toggle con estado; al cambiarlo se reenvía el comando completo.
   - **Al prender (2026-07-13):** swing y sleep conservan lo vigente en el tile (misma regla que la temperatura). Sleep va implícito en el comando completo de encendido. Para swing: comparar los códigos `swing_on` y `swing_off` de ese aire — si son **diferentes**, después de mandar el encendido se manda el código de swing correspondiente al estado del tile; si son **iguales** (toggle), no se manda nada (no se puede saber el estado real del equipo).

6. **Branding — HA invisible (2026-07-13).** El usuario nunca debe enterarse de que de fondo hay un Home Assistant. En TODOS los textos visibles de la app (wizard de pairing, settings, mensajes de error, nombres de campos) se habla de **"Pantea Home Manager"**: el campo de conexión es "Host/IP de Pantea Home Manager", nunca "Home Assistant IP" como hoy. Aplica la regla general de arquitectura de producto Pantea (Homey es la cara al cliente, HA oculto detrás).

7. **Learning por device (2026-07-13).** El learning deja de ser el botón global "Aprender AC": pasa a ser un **botón del propio device** que activa el modo learning de ese aire. Con el modo activo, el próximo comando va a `ac_learn` en lugar de `ac_command`, y **se apaga solo tras el primer comando ejecutado** después de activarlo (confirmado por Fernán).

8. **Fallback legacy sigue vivo (2026-07-13).** Planilla primero (`command_code`); si el código no está, se manda el payload legacy (`device: "ac1"`, hvac_mode, fan_mode, sleep, temperature) para que el servidor lo resuelva con los códigos aprendidos vía `ac_learn`. Igual que el script actual.
9. **Temperatura ambiente con device fuente (2026-07-13).** `measure_temperature` se alimenta de OTRO device de Homey:
   - En el **pairing** se elige el device fuente de un **drop-down con todos los devices que tengan `measure_temperature`**. Si no se elige ninguno, la capability **se quita** del dispositivo (add/removeCapability dinámico — confirmado factible, lights ya lo usa).
   - Después es **editable en settings** como campo de texto: se valida que el nombre corresponda a un device con esa capability (si no, se rechaza el cambio); si queda vacío, se quita la capability.
   - La app espeja el valor del device fuente (suscripción vía HomeyAPI).
10. **Manejo de errores de envío (2026-07-13).** Si el POST al servidor falla: **reintentos** (ej. 3 con backoff corto) → si falla definitivo: **warning en el device** + **revertir la UI** al valor anterior + **mensaje a Telegram**. Para Telegram se reutiliza la configuración del tile "Envio a Telegram" de com.panteasmart.lights (token/chats en los settings de ese device; el mecanismo de acceso — leer settings vía HomeyAPI o API app-to-app — se define en la implementación).
11. **fan_mode con turbo (2026-07-13).** El picker de velocidad es auto/low/medium/high/**turbo**, igual que los tiles actuales de Device Capabilities.

12. **Formato de la planilla relevado (2026-07-13).** Webservice consultado en vivo; formato y contenido documentados en [planilla-ir.md](planilla-ir.md). El `code` es un número entero que identifica un juego de códigos IR y **suele servir para varias marcas** (no es marca/modelo). Filas `{code, mode, fan, temp, sleep, irCommand}` + columnas de validación internas; filas sin temp se indexan por modo solo.

13. **Autodetección desde la planilla + override (2026-07-13).** "Modo/ON separado" y "tiene fan_mode aprendido" se **autodetectan** de las filas del code (filas de modo solo → secuencia modo→wait→completo; filas con fan ≠ auto → fan aprendido). En settings avanzados hay un **override opcional de 3 estados**: "Auto (según planilla)" [default] / "Forzar sí" / "Forzar no". Nota técnica: los settings de Homey son estáticos (no se pueden mostrar/ocultar según el code elegido), pero el default "Auto" logra el mismo efecto — el comportamiento queda determinado por el code salvo que el instalador fuerce otra cosa.
14. **Mantenimiento de la planilla (2026-07-13).** La mantiene **Fernán**. Proceso ante un tipo de aire nuevo: se hace el learn de todos los comandos (vía `ac_learn`), y después Fernán copia los códigos desde el archivo que genera la integración Broadlink en el servidor al spreadsheet. (Responde también el resto de la pregunta 7: lo aprendido queda en el servidor y pasa a la planilla a mano.)
15. **URL del webservice configurable (2026-07-13).** La URL del Apps Script se puede modificar en la **configuración de la app** (a nivel app, igual para todos los tiles), con la URL actual de PS Broadlink.js como **valor por defecto**.

## Preguntas abiertas
4. **Campos del wizard de pairing.** Con las autodetecciones (def. 13) la lista tentativa quedó más corta: nombre del device, host/IP de Pantea Home Manager (+puerto), entidad remote, code de la planilla, device fuente de temperatura (drop-down, def. 9), auto-on al mover temperatura. ¿Confirmás? ¿Algo más/menos?
5. ~~Retorno HA→Homey~~ → RESUELTO (definición 9): measure_temperature se espeja de otro device de Homey elegido en pairing/settings; sin device fuente, se quita la capability.
6. ~~Manejo de errores~~ → RESUELTO (definición 10): reintentos + warning + revertir UI + Telegram.
7. ~~Botón Learning~~ → RESUELTO (definiciones 7 y 14): botón por device, se apaga tras el primer comando; lo aprendido queda en el servidor y Fernán lo pasa a mano a la planilla.
8. **Alcance.** ¿Estructura pensada para más tipos de device virtual a futuro o app "de los AC"? ¿Flow cards (hoy no hay ninguna)?
9. ~~HomeyScript "PS Broadlink" (falta el código)~~ → RESUELTO: código en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Del análisis salen las preguntas 10–15.
10. **Swing.** PARCIALMENTE RESUELTO (ver definición 5): swing va como comando separado con códigos on/off (filas `swing_on`/`swing_off` en la planilla — el formato actual ya soporta filas sin temp indexadas por modo). Queda pendiente: confirmar que hoy efectivamente no se envía nunca (el script lo lee pero no lo pone en el payload) y que los flows/planilla actuales no lo cubren por otro lado.
11. ~~Fallback legacy~~ → RESUELTO (definición 8): sigue vivo, igual que el script.
12. ~~Learning global vs por device~~ → RESUELTO (definición 7): botón por device.
13. ~~"Modo/ON separado" / fan aprendido~~ → RESUELTO (definición 13): autodetección desde la planilla + override de 3 estados en settings avanzados. Queda el detalle: ¿el wait de 2s entre comando de modo y completo va fijo o configurable?
14. **Cache de comandos IR.** Hoy: variable global de Homey, se invalida editando el script (`limpiarCache`). En la nueva app, ¿alcanza con cachear en memoria/store y un botón "recargar códigos" (maintenance action) para cuando se actualiza la planilla?
15. ~~Planilla / webservice~~ → RESUELTO (definiciones 12, 14 y 15): formato relevado; la mantiene Fernán (learn → archivo integración Broadlink → spreadsheet); URL configurable a nivel app con la actual como default.
