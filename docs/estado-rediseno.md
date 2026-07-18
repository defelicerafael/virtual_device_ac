# Estado del rediseño — punto de entrada de traspaso

Este archivo se actualiza al final de cada sesión de trabajo. Leerlo primero para retomar.

## Última actualización: 2026-07-18 (sesión tarde: deploy jx + sync de lockfiles)

### 🔜 PENDIENTES AL RETOMAR (lo próximo, en orden de valor)
1. **Prueba de aceptación del feedback (def. 26) en San Fran** — Fernán, celular: tocar "Prueba Zombie" (remote `test_claude` inexistente) → debe aparecer "El control no responde… Reconectar control" + Telegram, SIN que el tile revierta; y probar el botón "Reconectar control". Es lo único que falta para dar la def. 26 por cerrada. (Feedback ACTIVO solo en San Fran, que tiene su token propio de ferno cargado.)
2. ✅ **Deploy en jx (Sta Barbara OK) HECHO** (2026-07-18 tarde): SSH volvió; `update --no-install` (fast-forward a `ada108e`) + `install --last` → app con def. 26/27 instalada, SYNC=OK, DIRTY=NO. Queda en modo webhook hasta cargar su token propio (default base da 401 → webhook, no rompe). El Homey resolvió como "Sta Barbara OK" en `192.168.68.104` (la IP `.101` del estado estaba stale).
3. **Activar feedback en fatato** (casa con aires IR reales, la más útil): (a) actualizar su `ac_command.yaml` (ruta real verificada: `/opt/pantea/homeassistant/config/scripts/ac_command.yaml`, hoy en versión BASE sin `response_variable`) con el `response_variable` (referencia lista en `docs/referencia/ha-script-ac_command.yaml`; en ferno ya está aplicado, copiar igual con backup), y (b) cargar el token propio de fatato en los settings de la app (o re-clonar de la base para heredar el token default). El token de cada casa se crea en su HA (Perfil → Tokens de larga duración).
4. **Spot-checks restantes** con "Prueba Zombie": encendido en 2 pasos (code 5 → 2 POST separados 2s), camino legacy sin code.
5. **Migrar Living y Playroom** en San Fran (los 2 aires DC que faltan) → retirar el HomeyScript "PS Broadlink" cuando no queden tiles DC.
6. **Cierre (Etapa 7):** imágenes definitivas de la app (hoy placeholders azules), checklist final contra las 27 definiciones, mejora menor (cancelar reintentos supersedidos).

### ✅ Problema "no disponibles" RESUELTO (2026-07-16)
Causa raíz: `"discovery"` declarado en el driver ataba la disponibilidad de los devices al discovery mDNS (ids que jamás matchean → todos offline, en run e install). Fix: estrategia a nivel app consultada vía `homey.discovery.getStrategy('phm')` (def. 25 intacta). **Verificado: 5/5 devices disponibles con la app INSTALADA; desplegado en los 3 Homeys; diagnóstico temporal revertido.** Historia completa y moraleja en [debug-modo-instalado.md](debug-modo-instalado.md). Reglas que quedan: nunca `run`/`stop` sobre una app que se quiere instalada (el quit desinstala y borra settings de app); `"discovery"` en un driver SOLO si el discovery encuentra a los devices de verdad.

### Fase actual
**Implementación — Etapas 0–6 completas y PROBADAS EN VIVO (2026-07-15).** Verificado en el Homey San Fran con el device "Prueba AC" (code 1, sensor "Mov Escritorio", entidad `remote.test_claude` inexistente a propósito):
- Wizard completo: consulta de code en vivo (resumen + **marcas** con el `?marcas=` ya publicado), drop-down de sensores, alta OK.
- Espejo de temperatura andando (HomeyAPI funcionó incluso en dev-mode).
- Guards de apagado (fan/sleep/swing quedan en el tile), resolución por planilla (`command_code`).
- Manejo de fallas completo: reintentos + warning + revert + **Telegram real** (config del tile de lights).
- **Entrega confirmada**: con host `192.168.88.101`, 9 comandos seguidos al primer intento sin reintentos.
- Ajustes de UX sobre la marcha: labels "Tiene modo HEAT/DRY/FAN?", "Tiene opción Sleep?", "Permitir elegir Velocidad?"; sleep como botón junto a Aprender; swing con opción "Desactivado"; driver "Control Remoto A/C"; **host = IP obligatoria sin default** (`.local` no resuelve desde el contenedor — verificado empíricamente); versión 2.0.0.

**DESPLIEGUE (actualizado 2026-07-16):** la app está **INSTALADA (persistente)** en CUATRO Homeys: **San Fran** (ferno, 192.168.88.100 — pasó de dev-run a install el 16/7 porque cada redeploy reiniciaba los aires reales; `run` solo para debug puntual), **jx → "Sta Barbara OK"** (192.168.68.101), **segun → "Cerrillos"** (192.168.80.16) y **fatato → "Talar"** (192.168.68.62; el PHM de esa casa es 192.168.68.60). Alta en `repos.txt` de cada server; actualizaciones: `homey-app update com.panteasmart.devices` + `install` en cada server. San Fran ya tiene migrados a la app nueva: Aire Escritorio, Aire Estar, Aire Cocina y Aire Cuarto.

**Cambios de UX/diseño post-prueba (2026-07-15):** def. 23 (warning por comando ausente en planilla con la clave exacta), def. 24 (IP del PHM a nivel app: pantalla de settings de app nueva, wizard/tile solo lectura, primer alta la siembra), swing on/off como botón junto a Sleep/Aprender, labels "Tiene modo HEAT/DRY/FAN? / Tiene opción Sleep? / Permitir elegir Velocidad?", swing con opción Desactivado, class queda `thermostat` (airconditioning existe y valida — revisar post-Alexa). **Alexa verificada por voz** (modo+temperatura vía skill de Homey — episodio "Aire Cocina": funcionó, el aire equivocado era la entidad remote mal configurada). PS Heating actualizado para soportar los Pantea AC (`Homey/HomeyScript/PS Heating_20260715.js`).

### ✅ Feedback de remote caído + Reconectar control — IMPLEMENTADO (2026-07-18, def. 26)
Código completo en la app (52 tests, validate publish OK): setting `ha_token` a nivel app; con token, `ac_command` va por REST `?return_response` y el device distingue red-caída (revierte) de remote-caído (warning "El control no responde… Reconectar control" + Telegram, sin revertir); botón maintenance `button.reconnect` que hace `reload_config_entry` del Broadlink. Sin token = webhook clásico (no rompe nada). Detalle completo en [rediseno-app.md](rediseno-app.md) def. 26.
✅ **jx (Sta Barbara OK) YA tiene el deploy de def. 26/27** (2026-07-18 tarde): el SSH volvió; `update --no-install` + `install --last` → HEAD `ada108e`, SYNC=OK, DIRTY=NO. Los **4 Homeys** quedan con def. 26/27 instalada. (jx en webhook hasta cargar su token.)

**Sync de lockfiles (2026-07-18 tarde):** `package-lock.json` de **devices** sincronizado a 2.0.0 (`ada108e`, pusheado) — resolvía el DIRTY que aparecía en cada install (el lock había quedado en 1.0.0 tras el bump). Regla nueva en memoria: al bumpear versión de una app Homey, usar `npm version` para sincronizar el lock. También sincronizado el lock de **lights** a 3.0.0 (commit LOCAL sin push en su branch `claude`, a pedido de Fernán). ferno sigue mostrando DIRTY en su clone hasta su próximo `homey-app update` (se limpia solo). Falsos positivos: los forks HA Community no declaran `version` top-level.

**Token por defecto (def. 27, 2026-07-18):** `DEFAULT_HA_TOKEN` en `app.js` con el token de la IMAGEN BASE (creado prendiendo el HA de la base 192.168.88.194, que se volvió a bajar y dejar como estaba). Se siembra en `ha_token` si la casa no tiene uno → los clones futuros lo heredan (firstboot no regenera auth). **Hallazgo: las 4 casas actuales tienen auth propia (el token base da 401 en todas)** → el default es para instalaciones NUEVAS; las viejas caen a webhook por el fallback 401→webhook (con cache `_tokenRejected`, no degrada). San Fran conserva su token propio de ferno (feedback activo ahí). Para activar feedback en una casa vieja: cargar SU token + tener el script con response_variable.

**Progreso 2026-07-18 (verificado en vivo):**
- ✅ `script.ac_command` con `response_variable` desplegado en **ferno** (backup `.bak-20260718-001144`, config validada, scripts recargados). Contrato confirmado con 3 pruebas REST directas: remote caído/inexistente → `{ok:false, reason:remote_unavailable}`, remote vivo → `{ok:true}`. Copia en `docs/referencia/ha-script-ac_command.yaml`.
- ✅ App con def. 26 instalada en los **4 Homeys**. **Token cargado en San Fran** (config de la app; verificado que el campo quedó guardado). Comando disparado en "Prueba Zombie" (remote `test_claude` inexistente) → la app llamó por REST.
- ⚠️ **Falta la confirmación visual del warning en el tile** (Fernán, celular: tocar Prueba Zombie → debe decir "El control no responde… Reconectar control") y **probar el botón "Reconectar control"**.
- ⚠️ **Para activar el feedback en las otras casas:** (1) actualizar `script.ac_command` con el `response_variable` (fatato/jx/segun tienen la versión base sin respuesta — con la base, la app con token igual no rompe: recibe respuesta vacía = trata como ok), y (2) cargar el token de esa casa en la config de la app. Fatato es la prioritaria (aires IR reales). El token de cada casa se genera en su HA (Perfil → Tokens de larga duración).
- Seguridad: el token de San Fran quedó en la config de esa app; NO está en el repo ni en docs.

### 📋 (histórico, ya resuelto arriba) pedido original 2026-07-16 — feedback de remote caído + recuperación a mano
Contexto (episodio "Aire Lavadero" en fatato): el WiFi se cayó ~1h45, los RM4 quedaron offline, y los comandos de los tiles "salían bien" (webhook 200) pero morían en HA con `remote.X missing or not currently available` — **el usuario no se enteró de nada**. Los webhooks son fire-and-forget: HA acepta y falla después, la app no lo ve. Además: los RM4 NO tienen reboot remoto (verificado en la lib broadlink 0.19.0 y upstream — solo corte de energía o esperar su auto-reboot por pérdida de nube).
La tarea, dos partes:
1. **Enterarse:** que el usuario sepa cuando tira un comando y el remote de destino no responde. Requiere cambiar el contrato con el servidor: en vez de webhook (sin respuesta), un endpoint que devuelva el resultado (¿REST API de HA con `?return_response`? ¿webhook que setea un helper que la app consulta? ¿script con response_variable?) → warning en el tile + Telegram como en def. 10.
2. **Recuperarse:** una acción a mano del usuario en Homey para intentar reconectar el Broadlink — opciones a explorar: botón/maintenance action que dispare en HA un reload del config entry de Broadlink (`homeassistant.reload_config_entry` vía webhook/script nuevo), toggle de un enchufe inteligente si el RM está detrás de uno, y/o reinicio de la app como palanca genérica. Definir con Fernán qué combinación.

**Falta para el cierre (Etapa 7):** spot-checks pendientes (2 pasos con code 5; camino legacy sin code; swing con filas swing_* cuando se carguen en la planilla; learning contra un Broadlink REAL cuando toque aprender un aire nuevo), imágenes definitivas, checklist contra las definiciones 1–25, mejora menor (cancelar reintentos supersedidos) y terminar la migración de los aires de San Fran (faltan Living y Playroom).
- ✅ Spot-check LEARNING (2026-07-16, en modo INSTALADO): Fernán activó Aprender en "Prueba Zombie" y mandó comandos → los POST llegaron al webhook `ac_learn` de HA, la automation "AC Learning Mode via Webhook" corrió hasta `remote.learn_command` (falló solo por la entidad de prueba inexistente, como se esperaba). Verificado además que el contrato `simple_mode` de la app matchea la automation del servidor (simple → `ir_{device}_{modo}`; completo → secuencia). El device "Prueba Zombie" (id 79954337-...) queda para los spot-checks restantes.
- ✅ Migración COCINA completa (2026-07-15): device nuevo "Aire Cocina" con entidad `remote.cocina` corregida (verificado en log), comandado por Alexa por voz.
- ✅ PS Heating actualizado CARGADO en el HomeyScript de San Fran (2026-07-15) — soporta Pantea AC.
- ✅ Prueba con `install` (no solo dev-run): cubierta por las instalaciones de jx y segun.

✅ **Desbloqueado y DESPLEGADO (2026-07-15):** Rafael dio acceso de escritura → branch `claude` pusheado a `defelicerafael/virtual_device_ac` → agregado a `repos.txt` en ferno → `homey-app init` clonó → **`homey-app run` corriendo en el Homey San Fran (192.168.88.100)**: app inicializada, driver `ac` OK, flow cards y capabilities cargadas. Log: `/opt/pantea/logs/homey/com.panteasmart.devices.log`. Falta la prueba funcional de Fernán desde la app de Homey (wizard + comandos con entidad remote inexistente). ⚠️ Recordar gotcha dev-mode: HomeyAPI (drop-down de sensores / espejo de temperatura / config Telegram) puede fallar en `run` por el DNS homeylocal — la prueba definitiva de esas tres es con `install`.

### Sesión 2026-07-16 (resumen)
- **Def. 25:** IP por defecto vía discovery mDNS-SD del core (`discovery/phm.json`) — primer alta con IP opcional si hay detección, sin revelar el servicio (branding def. 6).
- Defaults del wizard: solo HEAT tildado; DRY/FAN/Sleep/Velocidad destildados. Labels sin mayúsculas forzadas ("Tiene modo Heat?" etc.), `text-transform: none` en el wizard.
- Swing on/off como botón (junto a Sleep y Aprender). Swing con opción "Desactivado". Def. 23 (warning por comando ausente). Def. 24 (IP a nivel app + pantalla de settings de app).
- **Migración San Fran avanzada por Fernán:** Aire Escritorio, Aire Estar, Aire Cocina y Aire Cuarto en la app nueva. **Alexa por voz verificada** (el episodio "puse 25° Aire Cocina y se prendió el del escritorio" era la entidad remote mal cargada — corregida).
- **PS Heating actualizado y CARGADO** (soporte Pantea AC: sin onoff, setpoint entero 16-30, respeta allow_heat) — copia en `Homey/HomeyScript/PS Heating_20260715.js` del Drive.
- Apps Script: `?marcas=` publicado y verificado (el wizard ya muestra "Aplica a: ..."). Copia en [referencia/apps-script-webservice.gs](referencia/apps-script-webservice.gs).
- Arreglado `panteasmart.local` en la LAN (conflicto mDNS histórico; avahi renombrado — restart lo recuperó; ver memoria/gotcha). Confirmado empíricamente: los contenedores de apps NO resuelven `.local` → IP siempre.
- Instalada la app en los 3 Homeys; luego el ciclo run/stop desató el problema activo de arriba (ver [debug-modo-instalado.md](debug-modo-instalado.md)).

### Mapa de documentos
- [rediseno-app.md](rediseno-app.md) — las 20 definiciones de producto + relevamiento de la app vieja. TODO el detalle de qué hace la app está ahí.
- [propuesta-diseno.md](propuesta-diseno.md) — diseño APROBADO (arquitectura, capabilities, flujo de comando, lib/, wizard, flow cards, migración).
- [plan-implementacion.md](plan-implementacion.md) — las 8 etapas con su forma de prueba.
- [ps-broadlink-analisis.md](ps-broadlink-analisis.md) + [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js) — el HomeyScript que la app reemplaza.
- [planilla-ir.md](planilla-ir.md) — formato real del webservice de códigos IR (relevado en vivo).
- [debug-modo-instalado.md](debug-modo-instalado.md) — ⚠️ investigación del problema ACTIVO (devices no disponibles en modo instalado) con los próximos pasos en orden.
- [referencia/apps-script-webservice.gs](referencia/apps-script-webservice.gs) — el Apps Script del webservice (endpoints ?code= y ?marcas=, y extraerAC1 del proceso de la def. 14).

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
