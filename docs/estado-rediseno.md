# Estado del rediseño — punto de entrada de traspaso

Este archivo se actualiza al final de cada sesión de trabajo. Leerlo primero para retomar.

## Última actualización: 2026-08-06 (v2.1.0 — apagado automático, def. 28, SIN desplegar)

### 🆕 Def. 28 — Apagado automático (v2.1.0, 2026-08-06)
Slider `auto_off` en el tile con las horas que faltan para que el equipo se apague (0 = sin temporizador), habilitado por equipo con el setting `auto_off_mode`: **Desactivado** (default — los devices existentes no cambian), **Lo maneja Pantea** (la app cuenta y al vencer manda el apagado) o **Lo maneja el aire** (se le manda el temporizador por IR ahora). El slider baja solo en los dos modos y el vencimiento vive en el store, así que sobrevive a reinicios. Detalle completo, claves de planilla y casos borde en la [definición 28](rediseno-app.md). `npm test` 74/74 y `validate --level publish` OK.

**Lo que hay que saber para probarlo:**
- **Falta cargar los códigos en la planilla** para el modo "Lo maneja el aire": filas mode-only `timer_off_XX` (décimas de hora, 2 dígitos mínimo: `timer_off_05` = 0,5 h, `timer_off_10` = 1 h, `timer_off_120` = 12 h; `timer_off_00` = cancelar). Hasta que estén cargados, el modo IR revierte con "este equipo no tiene aprendido el apagado automático de X h" y **solo el modo "Lo maneja Pantea" es usable**.
- ⚠️ **PENDIENTE DE DEPLOY EN EL SERVIDOR:** el learning por barrido 0,5–12 h necesita dos cosas en cada HA (medir en vivo antes de asumir; al 2026-08-06 se miró **solo ferno**, que NO las tiene) —
  1. `docs/referencia/ha-script-ac_timer_learn.yaml` → `/opt/pantea/homeassistant/config/scripts/ac_timer_learn.yaml` (dos scripts: `learn_ac1_timer_off` con 0,5–12 y `learn_ac1_timer_off_horas` con 1–12; los dos arrancan por el comando de cancelar).
  2. La rama `elif mode.startswith("timer_off")` en la automation `ac_learning_mode_via_webhook` de `automations.yaml` → bloque completo en `docs/referencia/ha-automation-ac_learn.yaml`.
  Sin esto, el barrido despacha un script que no existe y **no aprende nada**. El alcance "Tiempo específico" (uno por uno) sí funciona tal cual está hoy: entra por la rama `simple_mode` que ya usa el swing.
- **El aviso de éxito NO es verde:** el SDK no tiene banner verde (`Device` solo expone `setWarning`/`setUnavailable`). Va por el banner amarillo con ✅ adelante, por decisión de Fernán.
- **Sin verificar en vivo todavía** (ni deploy ni prueba física en ferno).

## Actualización previa: 2026-08-03 (v2.0.9 DESPLEGADA en las 5 casas — verificado en vivo)

### ✅ Checklist de regresión contra las definiciones 1–27 (2026-07-28) — Etapa 7 punto 2 CERRADO
Documento nuevo: **[checklist-definiciones.md](checklist-definiciones.md)** (tabla def-por-def con el archivo donde se cumple cada una). Resultado: **25/27 sin desvíos**, 2 marcadas 🔍 porque su comprobación final es física (def. 21, filtrado de modos del picker) o depende del servidor (def. 26, `script.ac_command` enriquecido solo en ferno y fatato). `npm test` 61/61 y `validate --level publish` OK.

**5 hallazgos, ninguno crítico. Fernán decidió arreglar 1, 3, 4 y 5 → v2.0.9:**
1. **Learning colgado al cargar un code** (el único con impacto real): quitar la capability `learning_mode` no reseteaba `this._learning`, así que el siguiente comando se iba a `ac_learn` sin forma de apagarlo. Arreglado en `_syncAllowedFeatures`.
2. *(NO se arregla, decisión de Fernán)* el learning se apaga aunque el comando falle.
3. `_swingAfterPowerOn` contaba las 6 claves de swing juntas en vez de las del tipo del equipo → un toggle con una clave posicional al lado se mandaba igual. Arreglado con `SWING_POSITIONS` / `['on','off']`.
4. `remoteDown` silencioso en el swing post-encendido → ahora loguea (sigue sin revertir, correcto).
5. El trigger `swing_changed` se disparaba con `skipped` (sin código en planilla, no se enviaba nada) → ahora se saltea.

✅ **v2.0.9 DESPLEGADA y corriendo en los 5 Homeys** (ferno, jx, segun, fatato y boating) — verificado el 2026-08-03 contra `/api/manager/apps/app` de cada casa. ⚠️ Este párrafo decía "SIN desplegar" hasta esa fecha: el deploy se hizo y el doc no se actualizó. Ojo con creerle a un doc sin verificar. También quedó respondido ahí que el device **no persiste en ningún lado** que el swing sea toggle: se recalcula en cada encendido contra el cache de `ir-codes`.

### 🔜 PENDIENTES AL RETOMAR (lo próximo, en orden de valor)
1. ✅ ~~**Desplegar v2.0.9**~~ — **HECHO**: corriendo en las 5 casas (verificado 2026-08-03). El clone y la versión instalada coinciden en `2.0.9` en todas.
2. ✅ ~~**Limpiar PS Heating**~~ — **HECHO por Fernán el 2026-08-03**: sacó "Aire Living" del HomeyScript. Texto original: tras borrar el device "Aire Living" (2026-07-21, sin remote todavía en ese ambiente), quedó una referencia colgada — sacar el bloque del heater "Aire Living" y quitarlo del `waitBeforeOffAfterHeatersOff` de "Calefaccion Living". NO rompe (el script hace `continue` al no encontrar el device), solo mete ruido en los logs. Copia en `Homey/HomeyScript/PS Heating_20260715.js`. Verificado que Playroom sí tiene `remote.playroom` en HA.
3. **Spot-checks restantes** con "Prueba Zombie" (San Fran): encendido en 2 pasos (code 5 → 2 POST separados 2s), camino legacy sin code.
4. ✅ ~~**Migrar el aire de Playroom**~~ — **HECHO** (verificado 2026-07-28: "Aire Playroom" está en la app y `available`; los 7 aires de San Fran migrados). Living no cuenta: su device se borró el 21-jul porque el ambiente no tiene Broadlink.
   ✅ **RETIRADO el HomeyScript "PS Broadlink" (30-jul-2026)** — con esto se cierra el ciclo que arrancó el rediseño: la app reemplazó a los tres (tiles DC + Flows + script). Se borraron los 2 Advanced Flows (`AC Controller`, `AC Controller (Detail)`, ya deshabilitados), el script, y `PS Heating (old)` (nunca ejecutado). Backups: el código ya estaba en [`referencia/PS-Broadlink-original.js`](./referencia/PS-Broadlink-original.js) y los flows en [`referencia/AC-Controller-flows-backup-20260730.json`](./referencia/AC-Controller-flows-backup-20260730.json). ⚠️ "PS Broadlink RF" y "PS Heating" intactos (se verificó que ningún flow los referenciara: los nombres son substrings unos de otros).
   🪤 Gotcha: los HomeyScripts se borran **por `id`, no por nombre** — el DELETE por nombre devuelve `✓ Done` y no borra nada.
   ⚠️ Gotcha: para auditar flows hay que mirar `/api/manager/flow/advancedflow` (los normales son solo 8), y ese endpoint **se trunca en 64 KB por pipe de SSH** — redirigir a archivo EN la Pi y procesar ahí.
   - ⚠️ **Bloqueante para retirar RF, NO abordar todavía (Fernán, 2026-07-21):** existe un HomeyScript SEPARADO **"PS Broadlink RF.js"** (persianas por RF vía `remote.chicas`, webhook `rf_command`/`rf_learn`, modelo `windowcoverings_state`). Tiene los mismos vicios que el AC pre-def.26 (fire-and-forget sin feedback, `panteasmart.local` hardcodeado, depende de Device Capabilities con `restartApp`). **Esa integración NO anduvo** → hoy las persianas RF no funcionan por ahí, no es dependencia viva. Camino futuro (a diseñar cuando Fernán lo pida): driver `windowcoverings` RF en esta misma app reusando host/token/command-sender/feedback + enriquecer `rf_command.yaml` con `response_variable`. **Por ahora: no hacer nada.**
5. **Cierre (Etapa 7), resto** — migrado a issues de GitHub: imágenes definitivas → **issue #2**; cancelar reintentos supersedidos → **issue #3**. Los dos con prioridad MUY BAJA; el de imágenes espera input de diseño de Fernán.
   ✅ La verificación física del filtrado de modos del picker (def. 21) la hizo Fernán el 2026-08-03: **quedó OK**.
6. **Opcional:** feedback en jx/segun (falta su token + el script enriquecido en cada HA). Sin token siguen en webhook clásico, sin romper nada.

### ✅ Toggle "Mostrar token" (v2.0.8, 2026-07-21) — flota pareja
Checkbox debajo del campo de token en `settings/index.html` (alterna password↔text, patrón integrator). v2.0.8 instalada en los **4 Homeys** (ferno, fatato, jx, segun).

### ✅ Feedback ACTIVO y VERIFICADO en fatato (Talar) — 2026-07-19
Fernán cargó el token de fatato y probó end-to-end: apuntó un tile a una entidad inexistente (`zombie`) → **"No se encuentra la entidad remote.zombie en Pantea Home Manager…"**. Eso valida las 4 capas juntas: token OK (si fuera inválido, def. 27 lo degradaría al webhook **en silencio** y no habría mensaje), script enriquecido devolviendo `remote_not_found`, y el mapeo de la app con la entidad completa. **El caso "Aire Lavadero" que originó def. 26 ya está cubierto en la casa donde ocurrió.**
- fatato tiene 9 remotes Broadlink: gym, lavadero, cine, family, piano, seve, cocina, chicas, master.
- ⚠️ Recordatorio operativo: tras esa prueba hay que **restaurar la entidad real** del tile que se usó (quedó en `zombie`).
- **Casas con feedback ACTIVO: San Fran (ferno) y Talar (fatato).** jx/segun siguen en webhook (sin token).

### ✅ Rollout v2.0.7 + script COMPLETO (2026-07-19)
- **App v2.0.7 instalada en los 4 Homeys**: San Fran, Sta Barbara OK (jx), Cerrillos (segun), Talar (fatato).
- **Script `ac_command` enriquecido** (not_found vs unavailable) **ACTIVO en ferno y fatato** (fatato: backup `.bak-20260719-011441`, check_config OK, HA reiniciado y verificado vivo sin errores) **+ imagen base**. Falta en jx/segun (sin apuro: sin token no se consulta la respuesta).
- Verificado por IP: `panteasmart-fatato` = **192.168.68.60** = el PHM que apuntan los tiles de Talar. El script enriquecido quedó en el HA correcto.

### ✅ Def. 26 ACEPTADA (2026-07-19, prueba en vivo de Fernán con v2.0.7 en San Fran)
Los 7 checks pasaron con "Prueba Zombie" (remote `test_claude` inexistente): (1) toast/warning al enviar, (2) mensaje "No se encuentra la entidad remote.test_claude en Pantea Home Manager…", (3) revert del tile, (4) campanita/timeline, (5) Telegram con entidad, (6) "Aprender" desaparece con code y reaparece sin, (7) "Reconectar control" en Ajustes→Maintenance con el mismo mensaje detallado por motivo.
- **Historia v2.0.2→v2.0.7 (2026-07-18/19, iteraciones con feedback de Fernán en vivo):** (a) v2.0.2 `remoteDown` REVIERTE + notificación timeline (cambio de la def. original "sin revertir"); (b) v2.0.3 botón "Aprender" solo sin code (def. 7 rev.); (c) v2.0.4 migración `addCapability(button.reconnect)` para devices pre-def.26; (d) v2.0.5 mensajes de error por motivo (no_connection/service_missing/server_error/http_error + remote_not_found/remote_unavailable; `_notifyFail` unifica banner+Telegram+timeline); (e) v2.0.6 entidad completa `remote.X` en los mensajes; (f) v2.0.7 "Reconectar control" con la misma clasificación (pre-chequeo GET /api/states → 404 = not_found; no_connection/token_rejected/reload_failed). 61 tests.
- **Script `ac_command` ENRIQUECIDO y ACTIVO en ferno:** distingue `remote_not_found` (entidad no registrada) de `remote_unavailable` (registrada pero unavailable/unknown). Backup `.bak-20260718-211717`, check_config OK, contenedor HA reiniciado (consultado). **También en la IMAGEN BASE** (192.168.88.194, backup `.bak-20260718-211833`, HA apagado — lo toma el próximo clon). Canónico: `docs/referencia/ha-script-ac_command.yaml`. Gotcha: los yaml de scripts en los servers son de root → sudo.
- ✅ Deploy en jx (2026-07-18): SSH volvió, quedó con `ada108e` (pre-v2.0.2 — re-actualizar con el punto 1). El Homey de jx es "Sta Barbara OK" en `192.168.68.104` (la `.101` estaba stale).

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

**Falta para el cierre (Etapa 7):** spot-checks pendientes (2 pasos con code 5; camino legacy sin code; swing con filas swing_* cuando se carguen en la planilla; learning contra un Broadlink REAL cuando toque aprender un aire nuevo), imágenes definitivas, ~~checklist contra las definiciones 1–25~~ ✅ HECHO 2026-07-28 ([checklist-definiciones.md](checklist-definiciones.md)), mejora menor (cancelar reintentos supersedidos) y terminar la migración de los aires de San Fran (faltan Living y Playroom).
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
- [rediseno-app.md](rediseno-app.md) — las 27 definiciones de producto + relevamiento de la app vieja. TODO el detalle de qué hace la app está ahí.
- [checklist-definiciones.md](checklist-definiciones.md) — verificación del código contra las 27 definiciones, una por una (Etapa 7 punto 2), con los hallazgos y qué se hizo con cada uno.
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
- 🟡 **Etapa 7 — Cierre:** ✅ validate publish · ✅ v2.0.0 · ✅ **checklist defs 1–27 (2026-07-28, [checklist-definiciones.md](checklist-definiciones.md))** · 🟡 migración San Fran (faltan Living y Playroom) · ⬜ imágenes reales

### Pendiente / dependencias
- ✅ ~~Fernán: extender el Apps Script con `?marcas={code}`~~ — **HECHO y verificado (2026-07-16)**: el wizard ya muestra "Aplica a: …". Copia en [referencia/apps-script-webservice.gs](referencia/apps-script-webservice.gs).
- (sin dependencias externas abiertas)

### Reglas de trabajo
- Todo lo aprendido/definido/hecho se guarda en `.md` dentro de este repo (`docs/`).
- Actualizar este archivo cada sesión.
- Proponer alternativas y consultar nombres antes de fijarlos.

### Contexto útil
- Repo git en `Homey/Apps/com.panteasmart.devices`. El rediseño vive en el branch **`claude`**. En `master` quedó un `app.json` modificado sin commitear (previo, solo un label) y dos stashes viejos.
- Lado servidor: webhooks `ac_command` / `ac_learn`, patrón scripts Broadlink. HA de San Fran (prod actual del script): 192.168.88.101. HA fatato: 192.168.68.60.
- Debug de apps Homey: SSH a panteasmart-ferno, `/opt/pantea/scripts/homey-app run/log/install` (ojo gotcha DNS homeylocal en dev-mode). Validate: CLI local en la Mac.
