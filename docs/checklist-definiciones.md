# Checklist de regresión — definiciones 1–27 (Etapa 7, punto 2)

Verificación del código contra cada definición de [rediseno-app.md](rediseno-app.md).
Hecha el **2026-07-28** sobre el branch `claude` en v2.0.8 (los fixes que salieron
de acá quedaron en **v2.0.9**).

**Método:** lectura completa de `app.js`, `drivers/ac/{device,driver}.js`,
`lib/*.js`, `driver.compose.json`, `driver.flow.compose.json`, `pair/setup.html`,
`settings/index.html` y los compose de capabilities; `npm test` (61/61) y
`homey app validate --level publish` (pasa, con el warning esperado por el
permiso `homey:manager:api`).

**Leyenda:** ✅ implementada y verificable en código · 🔍 implementada, pero su
comprobación final es física o depende del servidor · ⚠️ desvío encontrado.

## Tabla

| # | Definición | Estado | Dónde se cumple |
|---|---|---|---|
| 1 | On/off restaura el último modo; la temperatura vigente del tile gana | ✅ | `device.js` `_onOnOff` / `_onTemperature`; `_lastMode` en store `last_mode` |
| 2 | Modos dry/fan + capability `fan_mode`; sin fan aprendido se manda `auto` | ✅ | `driver.compose.json` `capabilitiesOptions.thermostat_mode`; `command-sender._resolveEffectiveFan` |
| 3 | Wizard de pairing custom; `codigo_ac` fijo en "ac1" | ✅ | `driver.onPair` + `pair/setup.html`; `command-sender.LEGACY_DEVICE` |
| 4 | Absorber la lógica de PS Broadlink (lookup, cache, `command_code`, 2 pasos) | ✅ | `lib/ir-codes.js` (cache por code) + `command-sender.sendState`. Los 6 puntos de `ps-broadlink-analisis.md §"Qué tiene que absorber"` están cubiertos. Única diferencia: el cache es en memoria (el script usaba una variable global de Homey) — invalidación por el botón de def. 18 |
| 5 | Swing por tipo (on/off · posiciones · desactivado); sleep en la clave compuesta; reenvío de swing al prender | ✅ | `_syncAllowedFeatures` (una sola capability de swing por device), `_onSwing`, `_swingAfterPowerOn`, `ir-codes.getSwingCommands` |
| 6 | Branding: Home Assistant invisible, todo es "Pantea Home Manager" | ✅ | Grep sin resultados en texto visible. Las únicas apariciones son comentarios de código y la URL interna `homeassistant.reload_config_entry` |
| 7 | Learning por device, se apaga tras el primer comando; solo visible SIN code | ✅ | `_onLearning`, `_dispatch`, `_onSwing`, `_syncAllowedFeatures` (`syncCap('learning_mode', !hasCode)`) |
| 8 | Fallback legacy cuando la planilla no tiene el comando | ✅ | `command-sender._buildStatePayload` / `_buildModePayload` |
| 9 | `measure_temperature` espejada de otro device; capability dinámica | ✅ | `lib/temp-mirror.js`, `_syncTempCapability`, `_attachTempMirror`, validación en `onSettings` |
| 10 | Falla de envío → reintentos + warning + revert + Telegram | ✅ | `_postWebhook` (3 intentos, backoff 500 ms × intento), `_failure` → `_notifyFail` + throw |
| 11 | `fan_mode` con turbo | ✅ | `.homeycompose/capabilities/fan_mode.json` |
| 12 | Formato de planilla relevado | ✅ | `ir-codes._load` indexa igual que `planilla-ir.md` |
| 13 | Autodetección de 2 pasos y fan aprendido + override de 3 estados | ✅ | `ir-codes.hasModeOnlyRows` / `hasLearnedFan`; `_resolveTwoStep` / `_resolveEffectiveFan`; settings `two_step_override` / `learned_fan_override` |
| 14 | Mantenimiento de la planilla (proceso manual de Fernán) | — | Sin impacto en código |
| 15 | URL del webservice configurable a nivel app | ✅ | `app.js` `DEFAULT_WEBSERVICE_URL` + `settings/index.html` |
| 16 | Learning con encendido en 2 pasos (`simple_mode`) y learning sin temperatura | ✅ | `command-sender.sendLearn` |
| 17 | Campos del wizard; IP obligatoria y sin default | ✅ | `pair/setup.html` (el input de IP no trae `value`) |
| 18 | Botón "recargar códigos" | ✅ | `button.reload_codes` como `maintenanceAction`; `_onReloadCodes` → `irCodes.reload` |
| 19 | Flow cards de acción (+ triggers y conditions) | ✅ | `driver.flow.compose.json` + `driver._registerFlowCards` |
| 20 | Sin la palabra "virtual"; driver = "Control Remoto A/C" | ✅ | `driver.compose.json` `name` |
| 21 | Funciones configurables por equipo (heat/dry/fan/sleep/velocidad) | ✅ | `_syncAllowedFeatures` + `_assertModeAllowed`. **Verificación física HECHA por Fernán el 2026-08-03: quedó OK** — `setCapabilityOptions('thermostat_mode', {values})` efectivamente oculta los modos no permitidos en el picker. (Estuvo anotada como "a verificar en la prueba real" desde el diseño y el resultado nunca se había registrado.) La red de seguridad del listener sigue estando |
| 22 | Alcance del learning de temperaturas (rango / específica) | ✅ | `sendLearn` con `config.learnTempScope`; setting `learn_temp_scope` |
| 23 | Warning por comando ausente en la planilla | ✅ | `missing[]` en `command-sender`, `_warnMissing` en el device. La clave del warning es exactamente `{mode}_{fan}_{temp}_{sleep}` |
| 24 | IP del PHM en un solo lugar (nivel app) | ✅ | `_config()` (app primero, fallback a los settings viejos del device), `phm_host_info`, `get_phm` en el wizard. El fallback NO es código muerto: los devices creados antes del commit `985b001` conservan su `phm_host` guardado |
| 25 | IP por defecto vía discovery mDNS-SD del core | ✅ | `.homeycompose/discovery/phm.json` + `driver._discoverPhmDefault` (consultado por el MANAGER, nunca declarado en el driver — ver `debug-modo-instalado.md`) |
| 26 | Feedback de remote caído + botón Reconectar control | 🔍 | `_postServiceWithResponse`, `_warnRemoteDown` (banner + Telegram + timeline + throw), `reloadBroadlink` con motivos. **Depende del servidor:** el `script.ac_command` enriquecido está solo en ferno y fatato; el resto recibe respuesta vacía = `ok:true` (por diseño) |
| 27 | Token de HA por defecto + fallback robusto ante 401/403 | ✅ | `app.js` `DEFAULT_HA_TOKEN` (se siembra solo si `ha_token == null`, así un vaciado explícito se respeta); `_tokenRejected` + `resetTokenState` |

## Hallazgos y qué se hizo

Cinco desvíos, ninguno crítico. Decisión de Fernán (2026-07-28): se arreglan 1, 3,
4 y 5; el 2 queda como está.

1. **⚠️ ARREGLADO (v2.0.9) — el modo learning quedaba colgado al cargar un code.**
   `_syncAllowedFeatures` quitaba la capability `learning_mode` sin resetear
   `this._learning`. Secuencia: device sin code → el instalador toca "Aprender"
   → antes de mandar ningún comando carga el code → el botón desaparece **con el
   learning activo** → el siguiente comando se iba a `ac_learn` en vez de
   `ac_command` (el aire no responde) y ya no había botón para apagarlo; se
   limpiaba recién al reiniciar la app. Ahora se cancela el learning al quitar la
   capability, con log.

2. **~~NO se arregla~~ → ARREGLADO (v2.3.0, 2026-08-06): Fernán cambió de
   criterio.** El hallazgo original: `_dispatch` y `_onSwing` ponían
   `_learning = false` antes de mirar el resultado, así que con el PHM caído el
   instalador perdía el modo learning y además el tile revertía — la def. 7 dice
   "tras el primer comando *ejecutado*". Se había dejado así a propósito.
   Ahora el modo sobrevive a la falla (el mensaje con el motivo ya aparecía) y
   se apaga por comando exitoso, por 5 minutos de inactividad, o porque
   aparezca un code en los ajustes. Ver la revisión 2026-08-06 de la def. 7.

3. **⚠️ ARREGLADO (v2.0.9) — `_swingAfterPowerOn` no filtraba por el tipo de
   swing.** Contaba los códigos de las 6 claves (`on/off/auto/up/middle/down`)
   juntas. Un code con `swing_on` y `swing_off` **iguales** (toggle) más
   cualquier clave posicional daba `Set.size >= 2` y mandaba el toggle igual —
   justo el caso que la def. 5 quiere evitar. Ahora sólo se miran las claves del
   tipo del equipo (`['on','off']` o `SWING_POSITIONS`). Hoy no se manifestaba
   porque la planilla todavía no tiene filas `swing_*`.

4. **⚠️ ARREGLADO (v2.0.9) — `remoteDown` silencioso en el swing post-encendido.**
   Sólo se miraba `!result.ok`; un `ok:true, remoteDown:true` no dejaba traza.
   Sigue sin revertir (correcto: el encendido ya salió bien), pero ahora loguea.

5. **⚠️ ARREGLADO (v2.0.9) — el trigger `swing_changed` se disparaba con
   `skipped`.** Si la planilla no tenía el código, no se enviaba nada al equipo
   pero la flow card se disparaba igual. Ahora se saltea (el warning de def. 23
   se sigue mostrando).

## Respuesta a una pregunta que salió del punto 3

**¿El device deja asentado en algún lado que el swing es toggle?** No. La
detección "todos los códigos iguales = toggle" es efímera: se recalcula en cada
encendido leyendo `getSwingCommands(code)` del cache en memoria de `ir-codes` y
comparando con un `Set`. No hay setting, ni store, ni label que lo persista; si
se reinicia la app y se vacía el cache, se vuelve a resolver contra la planilla.

## Lo que este checklist NO cubre

Sigue siendo trabajo de campo (ver `estado-rediseno.md`):

- Spot-checks pendientes con "Prueba Zombie": encendido en 2 pasos (code 5),
  camino legacy sin code, swing con filas `swing_*` cuando se carguen.
- ~~Verificación física del filtrado de modos del picker (def. 21).~~ ✅ **HECHA por Fernán el 2026-08-03: quedó OK.**
- Imágenes definitivas de la app (hoy placeholders) → **issue #2** (prioridad muy baja).
- Mejora menor anotada: cancelar reintentos supersedidos → **issue #3** (prioridad muy baja).

## Cosas revisadas de paso que están OK

- **Branding** (def. 6): cero menciones a Home Assistant / HA / "virtual" en
  texto visible.
- **Build**: el `app.json` generado coincide con los compose — el problema 1 del
  relevamiento original ("el build no coincide con la intención") está muerto.
- **`package-lock.json`** sincronizado con `package.json` (regla de la flota:
  bumpear con `npm version`, si no el clone de la Pi queda DIRTY).
- **Contrato con Telegram** (def. 10): el driver `virtual_telegram` de
  `com.panteasmart.lights` (branch `claude`, ya con el settings 3.0) sigue
  exponiendo `telegram_token`, `telegram_chat_id` y `telegram_support_chat_id`,
  que son exactamente las 3 claves que lee `app._telegramChannelConfig()`.
- **Detalle de i18n**: el wizard (`pair/setup.html`) y la pantalla de settings de
  la app (`settings/index.html`) están escritos en español fijo, mientras el
  resto de la app es bilingüe es/en. No contradice ninguna definición (las dos
  pantallas las usa el instalador), pero queda anotado.
