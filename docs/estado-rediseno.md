# Estado del rediseño — punto de entrada de traspaso

Este archivo se actualiza al final de cada sesión de trabajo. Leerlo primero para retomar.

## Última actualización: 2026-07-13

### Fase actual
**Definición de producto** (todavía no se escribió código nuevo).

### Hecho
- Relevamiento completo de la app actual, punta a punta. Hallazgos y problemas documentados en [rediseno-app.md](rediseno-app.md).
- Detectado que el `app.json` compilado no incluye modos dry/fan ni `ha_port` por duplicación de config entre `.homeycompose/app.json` y `driver.compose.json`.

### Pendiente / próximo paso
- Fernán tiene que responder las 8 preguntas abiertas de [rediseno-app.md](rediseno-app.md) (las 1, 3 y 4 son las que destraban la propuesta de diseño).
- Con esas respuestas: armar propuesta de diseño (alternativas, consultar nombres de funciones antes de fijarlos — mismo método que lights).
- Después: definir implementación juntos.

### Reglas de trabajo
- Todo lo aprendido/definido/hecho se guarda en `.md` dentro de este repo (`docs/`).
- Actualizar este archivo cada sesión.
- Proponer alternativas y consultar nombres antes de fijarlos.

### Contexto útil
- Repo git en `Homey/Apps/com.panteasmart.devices`, branch `master` (origin en GitHub). Hay un `app.json` modificado sin commitear previo a este trabajo.
- Lado HA: webhooks `ac_command` / `ac_learn`, patrón scripts Broadlink (HA fatato 192.168.68.60, RM4 Pro).
- Debug de apps Homey: SSH a panteasmart-ferno, `/opt/pantea/scripts/homey-app run/log/install` (ojo gotcha DNS homeylocal en dev-mode).
