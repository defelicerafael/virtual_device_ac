# Rediseño com.panteasmart.devices

Documento vivo del rediseño desde cero de la app. Acá se registra todo lo que se aprende, se define y se decide. Ver [estado-rediseno.md](estado-rediseno.md) para el punto de entrada de cada sesión.

## Objetivo

App de Homey que permite dar de alta tantos devices como el usuario quiera; cada device es un aire acondicionado virtual con su configuración propia. Homey → webhook HA → Broadlink IR.

**Requisito clave:** el botón on/off debe activar/desactivar el termostato **igual a la última vez que estuvo prendido**.

## Cómo funciona la app actual (relevada 2026-07-13)

- Un solo driver `virtual_ac`, class `thermostat`.
- Capabilities: `onoff`, `target_temperature` (16–30°C paso 1), `measure_temperature`, `thermostat_mode`, `learning_mode` (botón), `swing_on_off`, `sleep_on_off`.
- Cada cambio de capability arma un **payload completo** y lo POSTea a HA:
  ```json
  {
    "remote_entity": "remote.<remote_entity_name>",
    "device": "<codigo_ac>",        // ej. "ac1"
    "hvac_mode": "cool",
    "sleep": "on|off",
    "swing": "on|off",
    "temperature": 24,
    "onoff": true
  }
  ```
  a `http://<ha_ip>:<ha_port>/api/webhook/ac_command` (o `ac_learn` si está el modo aprendizaje).
- **On/off actual (parcial):** guarda solo el *modo* en store (`last_mode`) y lo restaura al prender. Temperatura/swing/sleep no son snapshot: se manda el valor actual de las capabilities.
- **Auto-on:** setting `auto_on_temp_change` — al mover la temperatura estando apagado, prende en el último modo (o `cool`).
- Flag `_fromOnOffUpdate` para evitar doble envío entre los listeners de `onoff` y `thermostat_mode`.
- **Pairing:** alta automática con contador global (`Pantea Virtual AC N`), settings por defecto: `ha_ip: panteasmart.local`, `remote_entity_name: pantea_ac_N`, `codigo_ac: ac1` (fijo, NO incrementa), `ha_port: 8123`.
- Settings por device: `ha_ip`, `ha_port`, `remote_entity_name`, `codigo_ac`, `auto_on_temp_change`.
- Del lado HA: patrón scripts+webhooks `ac_*` (HA fatato 192.168.68.60, Broadlink RM4 Pro).

## Problemas encontrados en la app actual

1. **El build no coincide con la intención.** Config de driver duplicada en `.homeycompose/app.json` (Compose la IGNORA para drivers) y en `driver.compose.json` (lo que vale). El `app.json` compilado no tiene los modos `dry`/`fan` ni el setting `ha_port` declarado. El termostato real solo ofrece auto/heat/cool/off.
2. **Sin feedback de errores:** si el webhook falla solo se loguea; la UI queda mostrando un estado que nunca llegó al aire.
3. **Sin retorno HA→Homey:** hay listener sobre `measure_temperature` pero nada la actualiza. 100% unidireccional.
4. **`fan_mode` (velocidad) comentado** en el código — empezado y abandonado.
5. Menores: sleep/swing definidas como `button` en `.homeycompose/capabilities/` pero `toggle` en otro lado; `package.json` dice `com.company.myapp`; autor Rafael Defelice; contador de pairing nunca decrementa.

## Definiciones tomadas

1. **On/off (2026-07-13).** Al prender: se restaura el **último modo** en que estuvo prendido, pero la **temperatura vigente del tile gana** — si alguien movió la temperatura estando apagado (con auto-on deshabilitado), al prender se usa esa temperatura nueva, no la del momento de apagar. `auto_on_temp_change` sigue existiendo como opción por device.
2. **Modos y velocidad (2026-07-13).** Se agregan los modos `dry` y `fan` (queda: off/auto/heat/cool/dry/fan) y la capability `fan_mode` (velocidad, con turbo — ver definición 11). En la config del tile habrá una opción "tiene fan_mode aprendido": si NO lo tiene, se envía siempre `auto` (comportamiento actual de todos los equipos).
3. **Pairing (2026-07-13).** Solo el **instalador** da de alta los equipos → se hace un **wizard de pairing con vistas custom** (cargar la config antes de crear el device, en vez de alta automática + corregir settings). `codigo_ac` deja de ser configurable: **siempre "ac1"**, porque ahora al device se le puede poner directamente el código con el que va a buscar el comando al webservice del Google Spreadsheet.
4. **Requisito nuevo — lógica del HomeyScript "PS Broadlink" (2026-07-13).** Como la app no funcionaba bien, hoy el trabajo real lo hace un HomeyScript en el Homey Pro de ferno "San Fran". Fernán pasó el código: copia en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis completo en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Es **indispensable** que la nueva app incorpore esa funcionalidad, en particular el lookup de comandos IR contra el webservice del Google Spreadsheet (`?code={code}` → filas `{mode, fan, temp, sleep, irCommand}`), el cache, el payload `command_code` con fallback legacy, y la secuencia "modo/ON separado". **Hallazgo clave:** en producción hoy los tiles son devices de la app Device Capabilities + Flows + este script — la nueva app reemplaza a los tres.

5. **Swing y sleep (2026-07-13).** Se modelan distinto:
   - **Swing (v3, 2026-07-15): tipo configurable por equipo.** El usuario elige en el wizard (y puede cambiarlo después en la config del tile — setting "Swing") entre:
     - **On/off:** toggle en el tile; comandos `swing_on` / `swing_off`.
     - **Por posición:** picker en el tile; comandos `swing_auto`, `swing_up`, `swing_middle`, `swing_down`, `swing_off` — permite aprender el swing en movimiento o posiciones fijas.
     - **Desactivado** (agregado 2026-07-15): el equipo no maneja swing — sin control en el tile (se quitan ambas capabilities).
     En la planilla todas son filas mode-only (`mode = "swing_up"`, sin temp) — sin columnas nuevas. Se envía solo el comando que tenga código en la planilla (sin código → queda en el tile). El learning aprende la clave correspondiente al tipo.
   - **Sleep:** sigue **dentro de la clave compuesta** `{modo}_{fan}_{temp}_{sleep}` — es parte del código que se envía junto con la temperatura, como hoy. En Homey: toggle con estado; al cambiarlo se reenvía el comando completo.
   - **Al prender (2026-07-13, generalizado 2026-07-15 al modelo multi-posición):** swing y sleep conservan lo vigente en el tile (misma regla que la temperatura). Sleep va implícito en el comando completo de encendido. Para swing: después del encendido se reenvía el código de la **posición vigente del tile**, solo si esa posición tiene código en la planilla y los códigos de swing no son todos iguales (todos iguales = toggle, no se puede saber el estado real). *(Generalización propuesta de la regla on/off original — confirmar.)*

6. **Branding — HA invisible (2026-07-13).** El usuario nunca debe enterarse de que de fondo hay un Home Assistant. En TODOS los textos visibles de la app (wizard de pairing, settings, mensajes de error, nombres de campos) se habla de **"Pantea Home Manager"**: el campo de conexión es "Host/IP de Pantea Home Manager", nunca "Home Assistant IP" como hoy. Aplica la regla general de arquitectura de producto Pantea (Homey es la cara al cliente, HA oculto detrás).

7. **Learning por device (2026-07-13).** El learning deja de ser el botón global "Aprender AC": pasa a ser un **botón del propio device** que activa el modo learning de ese aire. Con el modo activo, el próximo comando va a `ac_learn` en lugar de `ac_command`, y **se apaga solo tras el primer comando ejecutado** después de activarlo (confirmado por Fernán).

8. **Fallback legacy sigue vivo (2026-07-13).** Planilla primero (`command_code`); si el código no está, se manda el payload legacy (`device: "ac1"`, hvac_mode, fan_mode, sleep, temperature) para que el servidor lo resuelva con los códigos aprendidos vía `ac_learn`. Igual que el script actual.
9. **Temperatura ambiente con device fuente (2026-07-13).** `measure_temperature` se alimenta de OTRO device de Homey:
   - En el **pairing** se elige el device fuente de un **drop-down con todos los devices que tengan `measure_temperature`**. Si no se elige ninguno, la capability **se quita** del dispositivo (add/removeCapability dinámico — confirmado factible, lights ya lo usa).
   - Después es **editable en settings** como campo de texto: se valida que el nombre corresponda a un device con esa capability (si no, se rechaza el cambio); si queda vacío, se quita la capability.
   - La app espeja el valor del device fuente (suscripción vía HomeyAPI).
10. **Manejo de errores de envío (2026-07-13).** Si el POST al servidor falla: **reintentos** (ej. 3 con backoff corto) → si falla definitivo: **warning en el device** + **revertir la UI** al valor anterior + **mensaje a Telegram**. Para Telegram se reutiliza la configuración del tile "Envio a Telegram" de com.panteasmart.lights (token/chats en los settings de ese device; el mecanismo de acceso — leer settings vía HomeyAPI o API app-to-app — se define en la implementación).
11. **fan_mode con turbo (2026-07-13).** El picker de velocidad es auto/low/medium/high/**turbo**, igual que los tiles actuales de Device Capabilities.

12. **Formato de la planilla relevado (2026-07-13).** Webservice consultado en vivo; formato y contenido documentados en [planilla-ir.md](planilla-ir.md). El `code` es un número entero que identifica un juego de códigos IR y **suele servir para varias marcas** (no es marca/modelo). Filas `{code, mode, fan, temp, sleep, irCommand}` + columnas de validación internas; filas sin temp se indexan por modo solo.

13. **Autodetección desde la planilla + override (2026-07-13).** "Encendido en 2 pasos" (modo/ON separado) y "tiene fan_mode aprendido" se **autodetectan** de las filas del code (filas de modo solo → secuencia modo→wait→completo; filas con fan ≠ auto → fan aprendido). En settings avanzados hay un **override opcional de 3 estados**: "Auto (según planilla)" [default] / "Forzar sí" / "Forzar no". Nota técnica: los settings de Homey son estáticos (no se pueden mostrar/ocultar según el code elegido), pero el default "Auto" logra el mismo efecto.
    - **El code es OPCIONAL** (2026-07-13): un device **sin code** trabaja 100% por el camino legacy — manda el payload completo al servidor y este resuelve el comando según lo que ese remote tenga aprendido. Sin code no hay autodetección posible: el **override de "encendido en 2 pasos" es lo que habilita la secuencia** de 2 pasos (comando de modo con `simple_mode` → wait → payload completo, como el script). Análogamente, sin code el estado "Auto" del resto de los overrides equivale al comportamiento legacy directo (se envía lo elegido en el tile y el servidor resuelve).
14. **Mantenimiento de la planilla (2026-07-13).** La mantiene **Fernán**. Proceso ante un tipo de aire nuevo: se hace el learn de todos los comandos (vía `ac_learn`), y después Fernán copia los códigos desde el archivo que genera la integración Broadlink en el servidor al spreadsheet. (Responde también el resto de la pregunta 7: lo aprendido queda en el servidor y pasa a la planilla a mano.)
15. **URL del webservice configurable (2026-07-13).** La URL del Apps Script se puede modificar en la **configuración de la app** (a nivel app, igual para todos los tiles), con la URL actual de PS Broadlink.js como **valor por defecto**.

16. **Learning con encendido en 2 pasos (2026-07-13).** Con el modo learning activo en un device configurado en 2 pasos:
    - Si se modifica el **modo** del termostato → se envía **solo el modo** en la secuencia (el resto vacío, estilo `simple_mode` del script) → el servidor aprende el comando de encendido/modo.
    - Si se modifica la **temperatura** → se envía el learning **SIN temperatura** (payload completo pero sin temp). Del lado del servidor, el script de `ac_learn` se encarga solo de ir aprendiendo **todas las temperaturas de 16 a 30** en una sola sesión. (O sea: UN disparo de learning cubre todo el rango — no hay que repetir por temperatura, y el auto-apagado del botón tras el primer comando no molesta.)

17. **Campos del wizard — confirmados (2026-07-13).** Nombre, host/IP de Pantea Home Manager (+puerto), entidad remote, code de planilla (opcional), device fuente de temperatura, **"Encender al cambiar temperatura"** (al último modo utilizado o seleccionado).
    - **Ajuste 2026-07-15:** el campo pasa a llamarse **"IP Pantea Home Manager"**, **obligatorio y SIN default** (antes venía `panteasmart.local`, que NO resuelve desde el contenedor de la app — dos devices de prueba seguidos nacieron rotos por eso). Placeholder/hint: `192.168.88.101`.
18. **Cache de códigos (2026-07-13).** Alcanza con el botón **"recargar códigos"** (maintenance action en settings del device).
19. **Flow cards (2026-07-13).** Sí, se necesitan **cards de acción** (lista concreta a definir en la propuesta de diseño).

20. **Sin la palabra "virtual" (2026-07-13; nombre final 2026-07-15).** La palabra "virtual" no aparece en NINGÚN texto visible al usuario. El driver se muestra como **"Control Remoto A/C"** (es) / **"Air Conditioner Remote"** (en) al agregar el device. Complementa la definición 6 (branding).

21. **Funciones configurables por equipo (2026-07-15).** Cada device configura qué permite:
    - **Permite modo heat** / **modo dry** / **modo fan**: los modos no permitidos se ocultan del picker de modos (vía `setCapabilityOptions` por device — a verificar en la prueba real; red de seguridad: el listener rechaza modos no permitidos).
    - **Permite habilitar sleep**: si NO → la capability sleep se quita del tile, y en payload legacy y learning se envía siempre `sleep: "off"`.
    - **Permite cambiar la velocidad del fan**: si NO → la capability de velocidad se quita del tile, y en payload legacy y learning se envía siempre `fan: "auto"`.
    - El **wizard pregunta** estas opciones al dar de alta, y la **configuración del tile permite cambiar** la decisión después.
    - **Etiquetas (2026-07-15):** los nombres de modo van en inglés como en los controles reales — "Permite modo HEAT / DRY / FAN" y "Permite velocidad FAN".
    - **UI de sleep (2026-07-15):** `sleep_on_off` se muestra como **botón** (junto al botón "Aprender"), no como toggle en la lista.
    - **UI de swing on/off (2026-07-15):** `swing_on_off` también como **botón**, en la misma fila que Sleep y Aprender. (El swing por posición sigue siendo picker.)

22. **Alcance del learning de temperaturas (2026-07-15).** Setting en Avanzado "Aprendizaje de temperaturas": **"Rango completo (16–30)"** [default] → el learn va SIN temperatura y el servidor recorre todo el rango en una sesión; **"Temperatura específica"** → el learn va CON la temperatura vigente del tile, para corregir una temperatura mal aprendida sin repetir toda la sesión. Aplica a los learn de estado (no al comando de encendido de 2 pasos ni al swing, que son claves de modo solo). En un aire no-2-pasos, cambiar el modo con learning activo también dispara el learn con este mismo alcance ("cambio a heat con learning = aprendeme heat", rango o temperatura puntual según el setting).

23. **Warning por comando ausente en la planilla (2026-07-15).** Si el tile tiene code configurado y la clave buscada no existe en la planilla, el envío sale igual por el fallback legacy (def. 8) pero el tile muestra un **warning** con la clave faltante ("Comando no disponible en la planilla: cool_high_24_off"). Sin code configurado no hay warning (el legacy es el diseño, no un faltante). Se limpia en el próximo envío sin faltantes. Aplica también a swing (que no tiene fallback: skipped + warning).

## Preguntas abiertas
4. ~~Campos del wizard~~ → RESUELTO (definición 17).
5. ~~Retorno HA→Homey~~ → RESUELTO (definición 9): measure_temperature se espeja de otro device de Homey elegido en pairing/settings; sin device fuente, se quita la capability.
6. ~~Manejo de errores~~ → RESUELTO (definición 10): reintentos + warning + revertir UI + Telegram.
7. ~~Botón Learning~~ → RESUELTO (definiciones 7 y 14): botón por device, se apaga tras el primer comando; lo aprendido queda en el servidor y Fernán lo pasa a mano a la planilla.
8. **Alcance.** Flow cards → RESUELTO (definición 19): sí, cards de acción. Queda solo la parte estructural (¿preparada para más tipos de device a futuro?) — se resuelve en la propuesta de diseño.
9. ~~HomeyScript "PS Broadlink" (falta el código)~~ → RESUELTO: código en [referencia/PS-Broadlink-original.js](referencia/PS-Broadlink-original.js), análisis en [ps-broadlink-analisis.md](ps-broadlink-analisis.md). Del análisis salen las preguntas 10–15.
10. **Swing.** PARCIALMENTE RESUELTO (ver definición 5): swing va como comando separado con códigos on/off (filas `swing_on`/`swing_off` en la planilla — el formato actual ya soporta filas sin temp indexadas por modo). Queda pendiente: confirmar que hoy efectivamente no se envía nunca (el script lo lee pero no lo pone en el payload) y que los flows/planilla actuales no lo cubren por otro lado.
11. ~~Fallback legacy~~ → RESUELTO (definición 8): sigue vivo, igual que el script.
12. ~~Learning global vs por device~~ → RESUELTO (definición 7): botón por device.
13. ~~"Modo/ON separado" / fan aprendido~~ → RESUELTO (definición 13): autodetección desde la planilla + override de 3 estados en settings avanzados. Queda el detalle: ¿el wait de 2s entre comando de modo y completo va fijo o configurable?
14. ~~Cache de comandos IR~~ → RESUELTO (definición 18): botón "recargar códigos".
15. ~~Planilla / webservice~~ → RESUELTO (definiciones 12, 14 y 15): formato relevado; la mantiene Fernán (learn → archivo integración Broadlink → spreadsheet); URL configurable a nivel app con la actual como default.
