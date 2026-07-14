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
2. **Modos y velocidad (2026-07-13).** Se agregan los modos `dry` y `fan` (queda: off/auto/heat/cool/dry/fan) y la capability `fan_mode` (velocidad). En la config del tile habrá una opción "tiene fan_mode aprendido": si NO lo tiene, se envía siempre `auto` (comportamiento actual de todos los equipos).
3. **Requisito nuevo — lógica del HomeyScript "PS Broadlink" (2026-07-13).** Como la app no funcionaba bien, hoy el trabajo real lo hace un HomeyScript ("PS Broadlink.js" o similar) en el Homey Pro de ferno "San Fran": recibe el device virtual que disparó el evento y envía a HA la acción a realizar. Además puede consultar un **webservice de un Google Spreadsheet** para obtener el código de un comando en particular. Es **indispensable** que la nueva app incorpore esa funcionalidad (la lógica del script pasa a vivir adentro de la app).

## Preguntas abiertas

3. **Swing/sleep.** ¿Los códigos IR son toggle (mismo código alterna) o hay código on y código off? Define si en Homey son toggles con estado confiable o botones pulso. Al apagar el AC, ¿swing/sleep se resetean o se conservan? ¿Y al prender: se restauran los del último encendido o vale la misma regla que la temperatura (gana lo vigente en el tile)?
4. **Pairing.** ¿Quién da de alta — instalador o cliente? ¿Alta automática + corregir settings (hoy) o wizard con vistas custom (IP HA, entidad remote, código)? ¿`codigo_ac` auto-incrementa?
5. **Retorno HA→Homey.** ¿Incluir vía de vuelta (temperatura ambiente real, confirmación de envío IR) vía endpoint API de la app? ¿O unidireccional y se elimina `measure_temperature`?
6. **Manejo de errores.** Si HA no responde: ¿(a) revertir capability en UI, (b) warning/unavailable en el device, (c) reintentos? Combinables.
7. **Botón Learning.** ¿Visible en el device o maintenance action en settings avanzados? ¿Cómo es el flujo `ac_learn` del lado HA?
8. **Alcance.** ¿Estructura pensada para más tipos de device virtual a futuro o app "de los AC"? ¿Flow cards (hoy no hay ninguna)?
9. **HomeyScript "PS Broadlink" (falta el código).** No hay copia en el Drive (`Homey/HomeyScript/` tiene solo scripts de lights); vive en el Homey Pro "San Fran". Hace falta exportarlo/pegarlo para documentarlo. A responder mirándolo o de memoria:
   - ¿Cómo se dispara hoy? (¿un Flow que escucha cambios del device virtual y llama al script?)
   - ¿Qué manda a HA — el mismo webhook `ac_command` con el payload completo, u otra cosa (código IR crudo)?
   - ¿Qué devuelve el webservice del spreadsheet (código IR por comando? mapeo device→código?) y cuándo se consulta: siempre, como fallback, o solo para ciertos comandos? ¿URL/auth del webservice?
   - ¿El spreadsheet es la fuente de verdad de los códigos aprendidos, o conviven con lo aprendido vía `ac_learn` en HA?
