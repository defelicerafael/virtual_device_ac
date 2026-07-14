# Análisis del HomeyScript "PS Broadlink" (San Fran)

Copia original en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js) (pegada por Fernán, 2026-07-13). Este script es lo que hoy hace el trabajo real en producción; la nueva app debe absorber su lógica.

## Hallazgo principal

**El sistema en producción hoy NO usa la app `com.panteasmart.devices`.** Los tiles de AC son devices virtuales de la app **Device Capabilities** (`nl.qluster-it.DeviceCapabilities`), un Flow escucha los cambios y llama a este HomeyScript pasándole el device y la capability que cambió. El script lee el estado del tile, resuelve el comando IR y lo manda a HA. La nueva app reemplaza a los tres: tiles DC + Flows + script.

## Flujo completo

```
Tile DC "Aire XXX" → Flow → HomeyScript PS Broadlink
    → lee capabilities del tile
    → resuelve comando IR:
         1) cache en variable global Homey "BroadLinkIRCommands"
         2) si no está → GET al webservice del Google Spreadsheet
         3) si la planilla no lo tiene → fallback payload "legacy"
    → POST a http://192.168.88.101:8123/api/webhook/ac_command (o ac_learn)
```

## Estado que lee del tile DC (mapeo de capabilities)

| Dato | Capability del tile DC | Default si null |
|---|---|---|
| `temperature` | `target_temperature` | — |
| `hvac_mode` | `thermostat_mode` | — |
| **`code`** (código spreadsheet) | `measure_data_size` (reusada como campo numérico) | — |
| `sleep` | `onoffbuttontab_..._button-custom_31.boolean1` | `off` |
| `device` (número → "ac{N}") | `measure_..._slider_number.number2` | `1` → "ac1" |
| `fan_mode` | `devicecapabilities_picker-auto-low-medium-high-turbo_list` | `auto` |
| `swing` | `onoffbuttontab_..._button-custom_19.boolean2` | `on` |

- Solo procesa devices cuyo nombre empieza con "aire".
- `remote_entity`: si no viene por parámetro, se deriva del nombre: "Aire Escritorio" → `remote.escritorio`.
- **fan_mode incluye `turbo`**: auto/low/medium/high/turbo.
- **Learning es un botón GLOBAL** ("Aprender AC", un device aparte): si está ON, el próximo comando va a `ac_learn` y el script apaga el botón.

## Resolución del comando IR (lo nuevo vs. la app vieja)

1. **Clave de búsqueda:** `{hvac_mode}` solo (para off o comandos de modo), o `{hvac_mode}_{fan_mode}_{temperature}_{sleep}` (ej. `cool_auto_24_off`).
2. **Cache:** variable global de Homey `BroadLinkIRCommands`, dict por `code` → { claveComando → irCommand }. Flag `limpiarCache` (hardcodeado) para vaciarla.
3. **Webservice:** `GET https://script.google.com/macros/s/AKfy.../exec?code={code}` → JSON con filas `{mode, fan, temp, sleep, irCommand}`. Se cachean todas las filas del code de una vez. Filas con `mode == "off"` o sin `temp` se indexan solo por modo.
4. **Payload a HA:**
   - Si la planilla tiene el comando: `{ remote_entity, command_code: "<código IR crudo>" }` → HA solo lo dispara.
   - Fallback legacy (planilla no lo tiene): `{ remote_entity, device: "ac1", hvac_mode, fan_mode, sleep, temperature }` → HA lo resuelve con sus códigos aprendidos (`ir_{device}_...`, vía `ac_learn`).

## Lógica "modo/ON separado" (`modeOnDevices`)

Lista hardcodeada de aires cuyo encendido/modo es un comando IR separado del comando completo. Si el device está en la lista y lo que cambió fue `thermostat_mode` (≠ off):

- **Envío:** manda primero el comando de modo solo (planilla clave `{hvac_mode}`, fallback `{..., simple_mode: true}`), espera **2 segundos**, y después manda el comando completo.
- **Aprendizaje:** manda `{remote_entity, device, hvac_mode, simple_mode: true}` a `ac_learn` para que HA aprenda `ir_{dev}_{modo}`.

## Otras reglas de negocio

- Si cambió algo que no es `thermostat_mode` y el equipo está en `off` → no se envía nada (idéntico a la app vieja).
- **swing se lee y se loguea pero NUNCA va en el payload** → pregunta abierta (¿se maneja aparte? ¿quedó sin implementar?).
- No hay capability `onoff` separada en los tiles DC: prender/apagar ES `thermostat_mode`. El requisito "on/off restaura el último modo" lo tiene que aportar la nueva app.
- HA IP hardcodeada: `192.168.88.101:8123` (San Fran).
- Gran parte del script es la librería común Pantea (log/getDevice/getValue/etc. copiada en cada HomeyScript) — irrelevante para la nueva app, que usa el SDK directo.

## Qué tiene que absorber la nueva app

1. Lookup de comando IR: cache → webservice spreadsheet por `code` → payload `command_code`; fallback legacy si no está en planilla.
2. Clave de comando `{mode}_{fan}_{temp}_{sleep}` y variante modo-solo.
3. Opción por device "comando de modo/ON separado" (reemplaza `modeOnDevices` hardcodeado) con la secuencia modo → wait 2s → completo, y su variante de aprendizaje (`simple_mode`).
4. `fan_mode` con auto/low/medium/high/turbo.
5. Learning (hoy botón global; a definir si pasa a ser por device).
6. Cache de comandos con alguna forma de invalidación (hoy: editar el script).
