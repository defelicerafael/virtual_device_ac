# Estado del rediseño — punto de entrada de traspaso

Este archivo se actualiza al final de cada sesión de trabajo. Leerlo primero para retomar.

## Última actualización: 2026-07-13

### Fase actual
**Definición de producto** (todavía no se escribió código nuevo).

### Hecho
- Relevamiento completo de la app actual, punta a punta. Hallazgos y problemas documentados en [rediseno-app.md](rediseno-app.md).
- Detectado que el `app.json` compilado no incluye modos dry/fan ni `ha_port` por duplicación de config entre `.homeycompose/app.json` y `driver.compose.json`.
- Respondidas las preguntas 1 y 2 (on/off restaura último modo pero gana la temperatura vigente del tile; modos +dry/fan; fan_mode con opción "aprendido" por device) → sección "Definiciones tomadas".
- Apareció requisito nuevo indispensable: incorporar la lógica del HomeyScript "PS Broadlink" (Homey Pro San Fran) que hoy hace el trabajo real, incluida la consulta de códigos a un webservice de Google Spreadsheet.
- Respondida la pregunta 4: alta solo por instalador → wizard de pairing con vistas custom; `codigo_ac` fijo "ac1" (el código configurable pasa a ser el del lookup en el spreadsheet).
- **Conseguido y analizado el HomeyScript "PS Broadlink"**: copia en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Hallazgo clave: en producción los tiles son de la app Device Capabilities + Flows + script — la nueva app reemplaza a los tres. Lookup IR: cache → planilla (`command_code`) → fallback legacy; secuencia "modo/ON separado"; learning con botón global; fan_mode incluye turbo.

- Definición 5 (completa): swing = comando separado con códigos on/off (`swing_on`/`swing_off`; si el aire es toggle se repite el código); sleep = sigue dentro de la clave compuesta `{modo}_{fan}_{temp}_{sleep}`, parte del código que va con la temperatura.

### Pendiente / próximo paso
- Fernán tiene que responder las preguntas abiertas de [rediseno-app.md](rediseno-app.md): 3 (swing/sleep al apagar/prender), 4 (campos wizard), 5–8, 11–15 (fallback legacy sí/no, learning global vs por device, modo/ON separado, invalidación de cache, formato/ejemplo de la planilla).
- Con eso: armar propuesta de diseño (alternativas, consultar nombres de funciones antes de fijarlos — mismo método que lights).
- Con esas respuestas: armar propuesta de diseño (alternativas, consultar nombres de funciones antes de fijarlos — mismo método que lights).
- Después: definir implementación juntos.

### Reglas de trabajo
- Todo lo aprendido/definido/hecho se guarda en `.md` dentro de este repo (`docs/`).
- Actualizar este archivo cada sesión.
- Proponer alternativas y consultar nombres antes de fijarlos.

### Contexto útil
- Repo git en `Homey/Apps/com.panteasmart.devices`. El rediseño vive en el branch **`claude`** (creado desde `master` el 2026-07-13), igual que en lights. Hay un `app.json` modificado sin commitear previo a este trabajo (solo un texto de label) y dos stashes viejos.
- Lado HA: webhooks `ac_command` / `ac_learn`, patrón scripts Broadlink (HA fatato 192.168.68.60, RM4 Pro).
- Debug de apps Homey: SSH a panteasmart-ferno, `/opt/pantea/scripts/homey-app run/log/install` (ojo gotcha DNS homeylocal en dev-mode).
