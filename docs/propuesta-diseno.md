# Propuesta de diseño — nueva com.panteasmart.devices

BORRADOR para revisar con Fernán antes de escribir código. Basada en las definiciones 1–19 de [rediseno-app.md](rediseno-app.md). Los puntos marcados **[CONSULTAR]** necesitan su ok (método: proponer alternativas y consultar nombres antes de fijarlos).

## 1. Visión general

Una app, un driver de AC virtual. Cada device reemplaza a un trío actual (tile Device Capabilities + Flow + HomeyScript PS Broadlink): escucha sus propias capabilities, resuelve el comando IR (planilla → cache → legacy) y lo POSTea al webhook del servidor. Todo lo visible dice "Pantea Home Manager", nunca Home Assistant.

Estructura preparada para más tipos de device a futuro: la lógica compartida (planilla, envío, Telegram, espejo de temperatura) vive en `lib/`, el driver solo orquesta. Agregar un tipo nuevo = nuevo driver que reusa `lib/`.

## 2. Driver y capabilities

- Driver id: **[CONSULTAR]** propongo `ac` (nuevo, limpio). Alternativa: mantener `virtual_ac` (no hay migración que proteger — los tiles actuales no son de esta app — pero da continuidad con lo publicado).
- Class: `thermostat`.

| Capability | Tipo | Valores / opciones | Notas |
|---|---|---|---|
| `onoff` | estándar | — | Prender restaura último modo (def. 1); apagar = modo off |
| `thermostat_mode` | estándar | off/auto/heat/cool/dry/fan | def. 2 |
| `target_temperature` | estándar | 16–30 °C paso 1 | |
| `measure_temperature` | estándar | — | Solo si hay device fuente (def. 9); se quita si no |
| `fan_mode` | **custom** | auto/low/medium/high/turbo | def. 11. **[CONSULTAR]** nombre: propongo `fan_mode`; alt.: `pantea_fan_speed` |
| `swing_on_off` | custom | toggle | def. 5; mismo id que la app vieja |
| `sleep_on_off` | custom | toggle | def. 5; mismo id que la app vieja |
| `learning_mode` | custom | botón | def. 7; se apaga tras el primer comando |

**[CONSULTAR]** capabilities custom: propongo conservar los ids de la app vieja (`swing_on_off`, `sleep_on_off`, `learning_mode`) para no reinventar; solo se agrega `fan_mode`.

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
- El **wait de 2s** del encendido en 2 pasos: constante interna (no setting) — **[CONSULTAR]** ¿ok fijo?

## 5. Servicios compartidos (`lib/`)

**[CONSULTAR]** nombres de módulos y funciones principales:

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
- Device normal: payload completo a `ac_learn` (como el script).

## 7. Wizard de pairing (def. 3 y 17)

Vista custom única (o dos pasos si queda larga — **[CONSULTAR]** preferencia):

1. Nombre del device
2. Host/IP de Pantea Home Manager (default `panteasmart.local`) + puerto (default 8123)
3. Entidad remote (texto, sin el prefijo `remote.`)
4. Code de planilla (número, **opcional** — vacío = modo legacy)
5. Device fuente de temperatura (drop-down de devices con `measure_temperature` + opción "Ninguno")
6. Encender al cambiar temperatura (checkbox, default sí)

Validación en el wizard: si hay code, se consulta el webservice ahí mismo (feedback inmediato: "code 3: 31 comandos — cool/heat, fan auto" / "code no encontrado").

## 8. Flow cards de acción (def. 19)

**[CONSULTAR]** lista propuesta:

1. Prender (al último modo) / Apagar
2. Setear modo (picker off/auto/heat/cool/dry/fan)
3. Setear temperatura
4. Setear velocidad (picker con turbo)
5. Swing on/off, Sleep on/off

(Las estándar de `onoff`/`target_temperature`/`thermostat_mode` las da Homey solo por las capabilities; las custom necesitan cards propias: fan, swing, sleep.)

¿Triggers/conditions también? (ej. "se encendió", "el modo es X") — no pedidas; se pueden sumar después sin romper nada.

## 9. Migración y limpieza

- Los aires actuales (tiles DC) se migran a mano: dar de alta el device nuevo con el wizard, borrar tile DC + Flow. El HomeyScript queda hasta que no queden tiles DC.
- Se elimina del repo la config duplicada de `.homeycompose/app.json` (drivers definidos SOLO en `driver.compose.json`) — el bug de build actual desaparece.
- `package.json` con nombre real, autor Pantea Smart.
- Textos en `es` + `en` (locales), todos "Pantea Home Manager".

## 10. Qué NO hace esta versión

- No hay retorno de confirmación IR desde el servidor (solo el resultado HTTP del webhook).
- No escribe en la planilla (la mantiene Fernán a mano, def. 14).
- Un solo tipo de device (AC); la estructura queda lista para más.
