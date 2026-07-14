# Plan de implementación — nueva com.panteasmart.devices

Basado en [propuesta-diseno.md](propuesta-diseno.md) (aprobada 2026-07-13). Etapas pensadas para que cada una deje algo **probable** antes de seguir. Branch de trabajo: `claude`.

## Cómo se prueba (workflow general)

- Unit tests en `test/` (Node puro, mock de `fetch`) para la lógica pura: `ir-codes` y `command-sender`. Se corren local en la Mac, sin Homey.
- Pruebas reales: SSH a panteasmart-ferno, `/opt/pantea/scripts/homey-app run` (log/install) — ojo el gotcha conocido de DNS `homeylocal` en dev-mode.
- Contra el servidor: los webhooks `ac_command`/`ac_learn` reales. Se puede verificar el POST recibido mirando logs de HA, sin necesidad de un aire enfrente para las primeras pruebas.

## Etapa 0 — Limpieza de base

Dejar el repo listo para construir encima, sin arrastrar el bug de build:

1. Eliminar la sección `drivers` y `capabilities` de `.homeycompose/app.json` (queda solo la metadata de app); los drivers viven ÚNICAMENTE en `drivers/*/driver.compose.json`.
2. Borrar el driver `virtual_ac` completo (código viejo queda en la historia de git).
3. `package.json` real (`com.panteasmart.devices`, autor Pantea Smart), locales `en` + `es`.
4. Actualizar metadata de app: descripción sin "virtual", autor.

**Prueba:** `homey app validate` pasa y el `app.json` generado coincide con lo esperado.

## Etapa 1 — `lib/ir-codes.js` (planilla + cache)

La pieza más aislada y la de mayor valor: consulta al webservice, parseo de filas, armado de claves (`{mode}` / `{mode}_{fan}_{temp}_{sleep}` / `swing_on`/`swing_off`), cache en memoria por code, autodetecciones (`hasModeOnlyRows`, `hasLearnedFan`), `reload(code)`, y consulta de marcas (`?marcas={code}` — degrada si el Apps Script todavía no lo soporta).

**Prueba:** unit tests con fixtures tomados de las respuestas REALES del webservice (ya bajadas en el relevamiento: codes 1–5) + un test de integración opcional que pega al webservice de verdad.

## Etapa 2 — `lib/command-sender.js` + `lib/telegram.js`

- `command-sender`: armado de payloads (command_code / legacy / simple_mode / learning con y sin temp), secuencia de 2 pasos (wait 2s), reintentos (3, backoff corto), decisión de webhook (`ac_command`/`ac_learn`).
- `telegram`: `notifyFailure()` leyendo la config del tile "Envio a Telegram" de lights vía HomeyAPI (si no existe el tile, loguea y sigue).

**Prueba:** unit tests de payloads y secuencias con `fetch` mockeado (incluye: falla → reintentos → revert callback + telegram callback). Telegram real se prueba en etapa 5.

## Etapa 3 — Driver `ac` mínimo andando

- Capabilities compose: `fan_mode` (nueva), `swing_on_off`/`sleep_on_off`/`learning_mode` (heredadas), `driver.compose.json` con class thermostat, modos off/auto/heat/cool/dry/fan, temp 16–30, settings completos (con overrides 3 estados y maintenance action "recargar códigos").
- `device.js`: listeners de todas las capabilities → `command-sender`; regla on/off (último modo, def. 1); "encender al cambiar temperatura"; swing al prender (def. 5); learning (defs. 7 y 16); manejo de errores (def. 10: warning + revert; telegram viene de lib).
- Pairing PROVISORIO con template estándar (sin wizard todavía) para poder crear devices y probar.

**Prueba:** `homey-app run` en ferno; crear un device apuntando al HA de pruebas, verificar en logs de HA que llegan los POST correctos para: on/off, cambio de modo, temp, fan, swing, sleep, learning, 2 pasos (con un code que tenga filas de modo solo, ej. 5), y device SIN code (camino legacy).

## Etapa 4 — Wizard de pairing custom

Vista única (def. 17 + marcas): nombre, host/IP PHM + puerto, entidad remote, code opcional (con consulta en vivo: comandos disponibles + marcas/modelos), drop-down de devices con `measure_temperature` (vía HomeyAPI desde el driver), checkbox encender-al-cambiar-temp. Reemplaza el pairing provisorio.

**Prueba:** alta real de un device desde la app de Homey con y sin code; code inválido muestra error; el drop-down lista los sensores.

## Etapa 5 — `lib/temp-mirror.js` + Telegram real

- Espejo de `measure_temperature` desde el device fuente (suscripción HomeyAPI); alta/baja dinámica de la capability según config (def. 9); validación del nombre en `onSettings`.
- Probar el aviso Telegram real (tile de lights configurado en el Homey de pruebas).

**Prueba:** cambiar la temperatura del sensor fuente y verla reflejada en el tile del AC; renombrar/borrar el sensor y verificar la validación; apagar el HA de pruebas y verificar reintentos + warning + revert + mensaje de Telegram.

## Etapa 6 — Flow cards

Compose de acciones/triggers/conditions propias (velocidad, swing, sleep — sección 8 de la propuesta) y su runtime en `app.js`/`device.js`.

**Prueba:** Flow de prueba en el Homey que use cada card.

## Etapa 7 — Cierre y migración

1. `homey app validate` nivel publish; íconos/imágenes propios (sin "virtual").
2. Checklist de regresión completa (todas las reglas de las definiciones 1–20, una por una).
3. Migración de los aires reales de San Fran: alta con wizard → borrar tile DC + Flow correspondiente → cuando no quede ninguno, retirar el HomeyScript PS Broadlink.
4. Sync final de docs (regla de siempre) + versión 2.0.0.

## Dependencia externa (en paralelo, la maneja Fernán)

- **Extender el Apps Script**: parámetro `?marcas={code}` que devuelva las filas de la hoja "Marcas". La etapa 4 lo consume; hasta entonces el wizard degrada sin esa línea.

## Orden y criterio

0 → 1 → 2 → 3 (primer hito visible: un AC manejable desde Homey) → 4 → 5 → 6 → 7. Las etapas 1–2 son testeables sin Homey; de la 3 en adelante se trabaja con `homey-app run` en ferno. Cada etapa termina con sus docs actualizados y commit en `claude`.
