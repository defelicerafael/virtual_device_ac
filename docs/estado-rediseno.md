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

### Pendiente / próximo paso
- **Conseguir el código del HomeyScript "PS Broadlink.js"** del Homey Pro San Fran (no hay copia en el Drive) y documentarlo — pregunta 9 de [rediseno-app.md](rediseno-app.md).
- Fernán tiene que responder las preguntas abiertas restantes (3, 4-campos-wizard, 5–9); la 3 y el detalle del código del spreadsheet destraban la propuesta de diseño.
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
