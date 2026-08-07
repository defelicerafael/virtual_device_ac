# Planilla de códigos IR + webservice (Apps Script)

Fuente: Google Spreadsheet de Fernán ([link](https://docs.google.com/spreadsheets/d/1Cw4Bfzmv9o0rqMXs52FJ4VCQEEQ-FTojjrdTKrUkvtE/edit?gid=0#gid=0)), expuesta vía webservice de Apps Script. Relevada el 2026-07-13 consultando el webservice real.

## Webservice

- `GET https://script.google.com/macros/s/AKfy.../exec?code={code}` (URL completa en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js); código fuente en [referencia/apps-script-webservice.gs](referencia/apps-script-webservice.gs)).
- **Público, sin auth** (responde a cualquiera que tenga la URL).
- Devuelve JSON: array de filas de ese `code`.
- **`?marcas={code}`** (agregado 2026-07-15, para el wizard): filas de la hoja "Marcas" (cols Code/Marca/Modelo) → `[{"Marca":"Surrey","Modelo":"Inverter Smart (2022)"}, ...]`. Verificado en vivo.

## Formato de fila

```json
{
  "code": 1,
  "mode": "cool",
  "fan": "auto",
  "temp": 24,
  "sleep": "off",
  "irCommand": "JgAuAYyOEDQREhA1...",
  "Clave Repet.": "OK",
  "Comando Repet.": "OK",
  "Comando repet. en otro código": "OK"
}
```

- `irCommand`: código IR Broadlink en base64.
- Las tres columnas "Repet." son **validaciones internas de la planilla** (detección de claves/comandos duplicados); el consumidor las ignora.
- Filas sin `temp` se indexan por `mode` solo (así lo hace el script y así hay que mantenerlo).

## Semántica del `code`

- Es un **número entero** (1, 2, 3, ...), identificador del "juego de códigos IR". **Un mismo code suele funcionar para varias marcas** (protocolos IR compartidos entre fabricantes) — NO es marca/modelo.

## Relevamiento de codes existentes (2026-07-13)

| code | filas | modos | fans | sleep | temps | filas modo-solo |
|---|---|---|---|---|---|---|
| 1 | 166 | off/cool/heat/auto | auto/low/medium/high/turbo | on/off | 16–30 | solo `off` |
| 2 | 46 | off/cool/heat/auto | auto | off | 16–30 | solo `off` |
| 3 | 31 | off/cool/heat | auto | off | 16–30 | solo `off` |
| 4 | 31 | off/cool/heat | auto | off | 16–30 | solo `off` |
| 5 | 33 | off/cool/heat | auto | off | 16–30 | `off`, **`heat`, `cool` sin temp** |

## Hallazgos clave para el diseño

1. **El code 5 ya usa el patrón "modo/ON separado"**: tiene filas `heat`/`cool` SIN temp (comando de modo solo) además de las completas. → La app podría **autodetectar** si un aire necesita la secuencia modo→wait→completo mirando si su code tiene filas de modo solo, en lugar de un flag manual en el wizard.
2. **No hay filas de `dry` ni `fan`** (modo ventilador) todavía en ningún code — los modos nuevos van a requerir cargar códigos.
3. **No hay filas de swing** — confirma que swing hoy no se maneja por planilla; las filas `swing_on`/`swing_off` de la definición 5 son un agregado nuevo.
   - Lo mismo vale para las filas **`timer_off_XX`** del apagado automático (def. 28): también son mode-only sin temp, con el tiempo en **décimas de hora y mínimo 2 dígitos** (`timer_off_05` = 0,5 h · `timer_off_10` = 1 h · `timer_off_120` = 12 h) y **`timer_off_00` = cancelar el temporizador**. Todavía no hay ninguna cargada.
4. La cobertura por code es heterogénea (code 1 tiene todas las velocidades y sleep; 2–5 solo fan auto y sleep off) → la opción "tiene fan_mode aprendido" del wizard también podría autodetectarse (¿hay filas con fan ≠ auto para este code?).
5. El webservice es público sin auth: aceptable (solo lectura de códigos IR, baja sensibilidad), pero tenerlo presente.
