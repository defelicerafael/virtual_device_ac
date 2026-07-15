# Propuesta de diseño — nueva com.panteasmart.devices

APROBADA por Fernán el 2026-07-13 (con los ajustes de esa revisión incorporados). Basada en las definiciones 1–19 de [rediseno-app.md](rediseno-app.md).

## 1. Visión general

Una app, un driver de aire acondicionado. Cada device reemplaza a un trío actual (tile Device Capabilities + Flow + HomeyScript PS Broadlink): escucha sus propias capabilities, resuelve el comando IR (planilla → cache → legacy) y lo POSTea al webhook del servidor. Todo lo visible dice "Pantea Home Manager", nunca Home Assistant, y la palabra "virtual" no aparece en ningún texto de cara al usuario (def. 20).

Estructura preparada para más tipos de device a futuro: la lógica compartida (planilla, envío, Telegram, espejo de temperatura) vive en `lib/`, el driver solo orquesta. Agregar un tipo nuevo = nuevo driver que reusa `lib/`.

## 2. Driver y capabilities

- Driver id: **`ac`** (decidido 2026-07-13).
- Nombre visible del driver: **"Aire Acondicionado"** — la palabra "virtual" no aparece en ningún texto visible al usuario (def. 20), ni en el alta del device ni en el nombre por defecto.
- Class: `thermostat`.

| Capability | Tipo | Valores / opciones | Notas |
|---|---|---|---|
| `onoff` | estándar | — | Prender restaura último modo (def. 1); apagar = modo off |
| `thermostat_mode` | estándar | off/auto/heat/cool/dry/fan | def. 2 |
| `target_temperature` | estándar | 16–30 °C paso 1 | |
| `measure_temperature` | estándar | — | Solo si hay device fuente (def. 9); se quita si no |
| `fan_mode` | **custom** | auto/low/medium/high/turbo | def. 11. Nombre `fan_mode` (decidido) |
| `swing_on_off` | custom | toggle | def. 5 v3: presente si el equipo usa swing tipo "on/off" |
| `swing_mode` | **custom** | auto/up/middle/down/off | def. 5 v3: presente si el equipo usa swing "por posición" (picker) |
| `sleep_on_off` | custom | toggle | def. 5; mismo id que la app vieja. Se quita si "no permite sleep" (def. 21) |
| `learning_mode` | custom | botón | def. 7; se apaga tras el primer comando |

Capabilities custom: se conservan `sleep_on_off`, `swing_on_off` y `learning_mode` de la app vieja; se agregan `fan_mode` y `swing_mode`. El **tipo de swing** es configurable por equipo (wizard + settings): "on/off" pone `swing_on_off` en el tile, "por posición" pone `swing_mode` — la otra se quita dinámicamente. `fan_mode` se quita si "no permite cambiar velocidad" (def. 21).

**Funciones configurables por equipo (def. 21, 2026-07-15):** cinco flags por device — permite heat / dry / fan (ocultan modos del picker vía `setCapabilityOptions`, con rechazo en listener como red de seguridad), permite sleep y permite velocidad (quitan la capability). Sin sleep → siempre `sleep:"off"` en legacy/learning; sin velocidad → siempre `fan:"auto"`. El wizard los pregunta; los settings del tile permiten cambiarlos.

## 3. Modelo de estado

- Las **capabilities son la fuente de verdad** del estado del tile (plano, como en lights).
- Store por device: solo `last_mode` (último modo ≠ off). Nada más persiste: al prender ganan los valores vigentes del tile (def. 1).
- Config del device en settings (editables): host/IP + puerto, entidad remote, code (opcional), device fuente de temperatura, encender al cambiar temperatura, overrides 3-estados (2 pasos / fan aprendido), botón "recargar códigos".

## 4. Flujo de comando (el corazón)

Cada cambio de capability dispara UN envío coordinado:

```
cambio de capability
  → ¿está en off y no es cambio de modo/onoff? → no enviar (regla actual)
  → ¿learning activo? → rama learning (§6)
  → resolver comando:
      ¿tiene code?
        sí → clave: {mode}|{mode}_{fan}_{temp}_{sleep}|swing_on|swing_off
             cache → webservice → ¿está? → payload {remote_entity, command_code}
             ¿no está en planilla? → payload legacy
        no → payload legacy {remote_entity, device:"ac1", hvac_mode, fan_mode, sleep, temperature}
  → ¿encendido en 2 pasos? (auto por planilla u override; sin code: solo override)
      → comando de modo (planilla o simple_mode) → wait 2s → comando completo
  → POST con reintentos (3, backoff corto)
      → falla definitiva: warning + revertir capability + Telegram (def. 10)
```

Reglas particulares:
- **fan efectivo**: si "fan aprendido" (auto o forzado) es NO → se envía siempre `auto` (def. 2).
- **Swing**: comando propio (`swing_on`/`swing_off`). Al prender: si los códigos swing_on ≠ swing_off del code → después del encendido se manda el del estado del tile; si son iguales o no hay code → no se manda (def. 5).
- **Encender al cambiar temperatura** (setting): si está apagado y se mueve la temperatura → prende al último modo (como hoy). Si está deshabilitado → el cambio queda en el tile y se aplica al prender (def. 1).
- El **wait de 2s** del encendido en 2 pasos: constante interna, fija (decidido).

## 5. Servicios compartidos (`lib/`)

Nombres de módulos y funciones (decididos 2026-07-13):

| Módulo propuesto | Responsabilidad | Funciones clave (propuestas) |
|---|---|---|
| `lib/ir-codes.js` | Planilla + cache | `getCommand(code, key)`, `hasModeOnlyRows(code)`, `hasLearnedFan(code)`, `reload(code)` |
| `lib/command-sender.js` | Payloads, 2 pasos, reintentos, webhooks | `sendState(device, opts)`, `sendSwing(device, on)`, `sendLearn(device, opts)` |
| `lib/telegram.js` | Aviso de fallas leyendo la config del tile "Envio a Telegram" de lights vía HomeyAPI | `notifyFailure(device, error)` |
| `lib/temp-mirror.js` | Espejo de `measure_temperature` desde el device fuente (HomeyAPI, suscripción) | `attach(device, sourceName)`, `detach(device)` |

- Cache de planilla: en memoria a nivel app (dict por code), compartido entre devices con el mismo code. "Recargar códigos" lo limpia y re-consulta.
- URL del webservice: settings de app (pantalla de configuración de la app), default = URL actual de PS Broadlink (def. 15).

## 6. Learning (def. 7 y 16)

- Botón en el device. Activo → el próximo comando va a `ac_learn` y el botón se apaga.
- Device en 2 pasos: cambio de modo → payload solo-modo (`simple_mode`); cambio de temperatura → payload **sin temp** (el servidor recorre 16–30 solo).
- Device normal: payload completo a `ac_learn` (como el script), sin temperatura.
- **Swing (2026-07-15):** con learning activo, cambiar la posición de swing manda a `ac_learn` el payload `{remote_entity, device, swing: "up|middle|down|auto|off"}` para aprender esa posición. **⚠️ Requiere extender el script de `ac_learn` del lado servidor** (hoy no conoce swing) — contrato del payload a confirmar con Fernán.

## 7. Wizard de pairing (def. 3 y 17)

Vista custom única:

1. Nombre del device
2. Host/IP de Pantea Home Manager (default `panteasmart.local`) + puerto (default 8123)
3. Entidad remote (texto, sin el prefijo `remote.`)
4. Code de planilla (número, **opcional** — vacío = modo legacy)
5. Device fuente de temperatura (drop-down de devices con `measure_temperature` + opción "Ninguno")
6. Encender al cambiar temperatura (checkbox, default sí)
7. Funciones del equipo (def. 21): permite heat / dry / fan / sleep / velocidad (checkboxes, default sí)
8. Tipo de swing (def. 5 v3): on/off | por posición (default on/off — a confirmar)

Validación en el wizard: si hay code, se consulta el webservice ahí mismo con feedback inmediato: qué comandos tiene ("code 3: 31 comandos — cool/heat, fan auto") **y a qué marcas/modelos aplica** (decidido 2026-07-13; el dato está en la hoja "Marcas" del spreadsheet).

**⚠️ Requiere extender el Apps Script:** verificado 2026-07-13 que el webservice actual solo filtra por `code` en la hoja de códigos (`?code=Marcas`, `?sheet=`, `?brands=` devuelven `[]`). Hace falta agregarle un endpoint/parámetro (ej. `?marcas={code}`) que devuelva las filas de la hoja "Marcas". Lo coordina Fernán, que mantiene el Apps Script. Si el code no trae marcas, el wizard lo muestra igual sin esa línea.

## 8. Flow cards (def. 19 — acción, triggers y conditions decididos 2026-07-13)

Las de capabilities estándar (`onoff`, `target_temperature`, `thermostat_mode`) las genera Homey solo. Cards propias para lo custom:

**Acciones:**
1. Prender (al último modo) / Apagar *(estándar, gratis)*
2. Setear modo *(estándar, gratis)*
3. Setear temperatura *(estándar, gratis)*
4. Setear velocidad (picker auto/low/medium/high/turbo)
5. Swing on/off
6. Sleep on/off

**Triggers:**
1. Se encendió / se apagó *(estándar, gratis)*
2. Cambió el modo *(estándar, gratis)*
3. Cambió la velocidad
4. Swing cambió / Sleep cambió

**Conditions:**
1. Está encendido *(estándar, gratis)*
2. El modo es X *(estándar, gratis)*
3. La velocidad es X
4. Swing está on / Sleep está on

## 9. Migración y limpieza

- Los aires actuales (tiles DC) se migran a mano: dar de alta el device nuevo con el wizard, borrar tile DC + Flow. El HomeyScript queda hasta que no queden tiles DC.
- Se elimina del repo la config duplicada de `.homeycompose/app.json` (drivers definidos SOLO en `driver.compose.json`) — el bug de build actual desaparece.
- `package.json` con nombre real, autor Pantea Smart.
- Textos en `es` + `en` (locales), todos "Pantea Home Manager".

## 10. Qué NO hace esta versión

- No hay retorno de confirmación IR desde el servidor (solo el resultado HTTP del webhook).
- No escribe en la planilla (la mantiene Fernán a mano, def. 14).
- Un solo tipo de device (AC); la estructura queda lista para más.
