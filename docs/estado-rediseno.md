# Estado del rediseño — punto de entrada de traspaso

Este archivo se actualiza al final de cada sesión de trabajo. Leerlo primero para retomar.

## Última actualización: 2026-07-15

### Fase actual
**Implementación — Etapas 0–2 completas; Etapas 3–6 con CÓDIGO COMPLETO.** Todo lo que queda es la prueba real en Homey/servidor (bloqueada por el push) y la Etapa 7 (cierre/migración).

⛔ **BLOQUEO para la prueba real:** el push del branch `claude` a `defelicerafael/virtual_device_ac` está denegado — el usuario `fernanpizarro` (única auth en la Mac: gh + SSH) tiene solo lectura en ese repo (sí tiene push en `defelicerafael/panteasmart`). Fernán decidió **pedirle a Rafael** que lo agregue como colaborador con escritura. Cuando esté: push `claude` → agregar a `repos.txt` en ferno (`local|com.panteasmart.devices|git@github.com:defelicerafael/virtual_device_ac.git|claude|`) → `homey-app update` + `run` al Homey `.100` → probar con entidad remote inexistente (los POST se ven en logs de HA sin tocar aires). Todo eso ya está aprobado por Fernán.

### Mapa de documentos
- [rediseno-app.md](rediseno-app.md) — las 20 definiciones de producto + relevamiento de la app vieja. TODO el detalle de qué hace la app está ahí.
- [propuesta-diseno.md](propuesta-diseno.md) — diseño APROBADO (arquitectura, capabilities, flujo de comando, lib/, wizard, flow cards, migración).
- [plan-implementacion.md](plan-implementacion.md) — las 8 etapas con su forma de prueba.
- [ps-broadlink-analisis.md](ps-broadlink-analisis.md) + [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js) — el HomeyScript que la app reemplaza.
- [planilla-ir.md](planilla-ir.md) — formato real del webservice de códigos IR (relevado en vivo).

### Progreso de etapas
- ✅ **Etapa 0 — Limpieza de base (2026-07-15):**
  - `.homeycompose/app.json` solo con metadata (eliminado el bug de config duplicada de drivers/capabilities). Autor Pantea Smart, sin "virtual", `brandColor` #1E3A5F placeholder.
  - Driver `virtual_ac` borrado (queda en historia git). Capabilities custom conservadas (`swing_on_off`, `sleep_on_off`, `learning_mode`) para reusar ids en Etapa 3.
  - `package.json` real (+ script `test`), `locales/es.json`, README sin "virtual", `.DS_Store` al gitignore.
  - Imágenes de app: placeholders PNG generados (las reales van en Etapa 7 — antes NO existían y el manifest las referenciaba).
  - ✅ `homey app validate --level=publish` PASA (CLI homey 4.0.5 instalada en la Mac — no hace falta ir a ferno para validar).
- ✅ **Etapa 1 — `lib/ir-codes.js` (2026-07-15):** módulo Node puro (fetch/URL/log inyectados). API: `getFullCommand`, `getModeCommand`, `getSwingCommands`, `hasModeOnlyRows` (autodetección 2 pasos), `hasLearnedFan`, `getSummary` (wizard), `getBrands` (degrada a []), `reload`/`clearCache`. Cache en memoria por code. Errores de red/parseo → getters null (camino legacy); `reload` propaga. **13 unit tests en verde** (`npm test`, fixtures reales en `test/fixtures/code1..5.json`) + probado contra el webservice VIVO (summary code 5 twoStep:true, cool_turbo_22_off code 1, modo-solo heat code 5, brands degrada).
- ✅ **Etapa 2 — `lib/command-sender.js` + `lib/telegram.js` (2026-07-15):**
  - `CommandSender.sendState(config, state, trigger)`: fan efectivo (autodetección/override), planilla→`command_code` / fallback legacy (`device:"ac1"`), encendido en 2 pasos SOLO con `trigger==='mode'` (paso modo → wait 2s fijo → completo; si el paso 1 falla no envía el 2), reintentos 3 con backoff creciente (500ms×intento). `sendSwing`: solo si hay código en planilla (si no, `skipped`). `sendLearn`: siempre payload estilo legacy SIN temperatura (el servidor recorre 16–30); 2 pasos + trigger mode → `simple_mode`.
  - `TelegramNotifier.notifyFailure()`: chat de SOPORTE con fallback a chat cliente (config del tile de lights vía `getChannelConfig` inyectado — el cableado HomeyAPI va en Etapa 5). Nunca lanza.
  - **33 tests en verde** (incluye fixture sintético code 99 con filas swing_on/swing_off, que la planilla real aún no tiene). Validate publish sigue OK.
  - ⚠️ Decisiones menores a confirmar con Fernán: (a) learning SIN temp también aplica cuando el trigger es modo en devices no-2-pasos (aprende el rango del modo elegido); (b) aviso Telegram va a chat soporte, fallback cliente.
- 🟡 **Etapa 3 — Driver `ac` (2026-07-15): código completo, PENDIENTE prueba real.**
  - **Cambio de alcance post-código (pedido de Fernán 2026-07-15):** (1) **swing con tipo configurable por equipo** (def. 5 v3, setting `swing_type` en wizard/settings): "on/off" → toggle `swing_on_off` (claves planilla `swing_on`/`swing_off`); "por posición" → picker `swing_mode` auto/up/middle/down/off (claves `swing_<pos>`); el device tiene UNA de las dos capabilities (sync dinámico); learning por clave como modo `swing_<clave>` + `simple_mode` (contrato de Fernán: reusa el camino existente, sin cambios en el servidor); (2) **funciones configurables por equipo** (def. 21): allow heat/dry/fan (filtra el picker con setCapabilityOptions + rechazo en listener), allow sleep y allow velocidad (quitan la capability; fuerzan sleep off / fan auto en payload y learning). Regla swing post-encendido generalizada: se reenvía la clave vigente del tile solo si hay ≥2 códigos swing distintos y esa clave tiene código (a confirmar). Default `swing_type: onoff` (a confirmar). Suite: **37/37**.
  - Capabilities: `fan_mode` nueva (picker con turbo, es/en); `swing_on_off`/`sleep_on_off` pasados a toggle; `learning_mode` botón; `button.reload_codes` como maintenance action.
  - `driver.compose.json`: "Aire Acondicionado" (sin "virtual"), class thermostat, modos off/auto/cool/heat/dry/fan (es/en), temp 16–30, settings agrupados (Conexión: host/puerto PHM + entidad remote; Equipo: code, fuente de temperatura, encender al cambiar temperatura; Avanzado: overrides 3 estados). Pairing PROVISORIO (template estándar; wizard en Etapa 4).
  - `device.js`: todas las reglas — on/off restaura último modo (store `last_mode`); temp con auto-on enciende (trigger mode ⇒ 2 pasos) o queda en tile; fan/sleep/swing en off no envían; swing post-encendido solo si `swing_on`≠`swing_off`; learning por device que se apaga tras el primer comando; falla ⇒ warning + Telegram + THROW (la UI revierte sola — las capabilities acompañantes se setean solo tras éxito); measure_temperature se agrega/quita según `temp_source` (espejo real en Etapa 5); validación de code numérico en onSettings.
  - `app.js`: servicios compartidos (irCodes con URL en settings de app + default PS Broadlink, commandSender, telegram stub hasta Etapa 5).
  - Assets: ícono del driver recuperado del viejo; imágenes placeholder.
  - ✅ validate publish OK, 33/33 tests. **Falta:** correr en Homey real y verificar POSTs (checklist en plan-implementacion.md Etapa 3).
- 🟡 **Etapa 4 — Wizard custom (2026-07-15): código completo, PENDIENTE prueba real.**
  - Permiso `homey:manager:api` + dep `homey-api@^3` (patrón de lights); `app.getHomeyApi()` lazy con degradación (gotcha DNS homeylocal en dev-mode).
  - Pairing con vista custom única `drivers/ac/pair/setup.html`: nombre, host/IP PHM (+puerto), entidad remote (normaliza prefijo `remote.`), code opcional con **consulta en vivo** (resumen de comandos + marcas si el Apps Script ya soporta `?marcas=` — degrada sin eso), drop-down de sensores con `measure_temperature` (HomeyAPI, degrada a "Ninguno"), auto-on, 5 funciones del equipo, tipo de swing. `driver.onPair` con handlers `get_temp_devices` / `check_code` / `build_device` (valida y arma el device con uuid). `.homeyignore` para docs/ y test/.
  - ✅ validate publish OK (warning esperado por el permiso api), 37/37 tests. **Falta:** prueba de alta real en el Homey.
- 🟡 **Etapa 5 — temp-mirror + Telegram real (2026-07-15): código completo, PENDIENTE prueba real.**
  - `lib/temp-mirror.js`: suscripción vía HomeyAPI `makeCapabilityInstance` (patrón lights), siembra valor inicial, re-attach reemplaza suscripción, detach en onDeleted/onUninit. Validación en onSettings: nombre inexistente → se rechaza el cambio (si la HomeyAPI está caída no se bloquea).
  - `app.js`: `_telegramChannelConfig()` lee los settings del tile `virtual_telegram` de lights vía HomeyAPI (token / chat cliente / chat soporte) — el TelegramNotifier ya no es stub.
  - 4 tests nuevos con HomeyAPI falsa → **41/41**. Falta probar en Homey real (sensor de verdad + tile de Telegram configurado).
- 🟡 **Etapa 6 — Flow cards (2026-07-15): código completo, PENDIENTE prueba real.**
  - `driver.flow.compose.json`: triggers `fan_speed_changed` (token speed) / `swing_changed` (token swing) / `sleep_turned_on|off`; conditions `fan_speed_is` / `swing_is` / `sleep_is_on`; actions `set_fan_speed` / `set_swing_onoff` / `set_swing_position` / `set_sleep`. Las de onoff/modo/temperatura las regala Homey.
  - Runtime en `driver._registerFlowCards()`: actions vía `triggerCapabilityListener` (mismo camino que el tile, con error amigable si la capability no está por def. 21/5v3); triggers disparados desde `device._triggerFlow()` tras cambios exitosos.
  - ✅ validate publish OK (es/en completos, titleFormatted incluidos).
- ⬜ Etapa 7 — Cierre (imágenes reales, checklist defs 1–20, migración San Fran, v2.0.0)

### Pendiente / dependencias
- ⚠️ **Fernán: extender el Apps Script** con `?marcas={code}` (hoja "Marcas") — lo consume la Etapa 4; el wizard degrada sin eso.

### Reglas de trabajo
- Todo lo aprendido/definido/hecho se guarda en `.md` dentro de este repo (`docs/`).
- Actualizar este archivo cada sesión.
- Proponer alternativas y consultar nombres antes de fijarlos.

### Contexto útil
- Repo git en `Homey/Apps/com.panteasmart.devices`. El rediseño vive en el branch **`claude`**. En `master` quedó un `app.json` modificado sin commitear (previo, solo un label) y dos stashes viejos.
- Lado servidor: webhooks `ac_command` / `ac_learn`, patrón scripts Broadlink. HA de San Fran (prod actual del script): 192.168.88.101. HA fatato: 192.168.68.60.
- Debug de apps Homey: SSH a panteasmart-ferno, `/opt/pantea/scripts/homey-app run/log/install` (ojo gotcha DNS homeylocal en dev-mode). Validate: CLI local en la Mac.
