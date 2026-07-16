# Debug: devices "no disponibles" en modo instalado (2026-07-16)

Registro completo de la investigación. Estado al cierre: **NO RESUELTO — el fix de `setAvailable()` no alcanzó; próximo paso: REINICIAR EL HOMEY** (decisión de Fernán pendiente, ver última sección).

## Síntoma

Con la app **instalada** (`homey-app install`) en San Fran, todos los aires aparecen "Dispositivo no disponible" en la app de Homey y en my.homey.app. Con la app en **sesión dev** (`homey-app run`) todo funciona perfecto.

## Hallazgos del camino (cronológico)

1. **`homey app run` DESINSTALA la app al terminar** ("uninstalls on quit"). El `homey-app stop` del server mata la sesión → la app desaparece del Homey por completo (verificado vía API: `Not Found: App with ID com.panteasmart.devices`). **Además borra los settings de app** (IP del PHM, URL de planilla). Esto explicó una tanda de "no disponibles": no había app.
2. Tras reinstalar: `Homey.apps.getApp()` reporta `state: "running", origin: "devkit_install"`, pero los 4 devices siguen `available: false` (mensaje genérico), y la app **no figura en App Performance** de las Developer Tools.
3. Las apps instaladas **no streamean logs** a las herramientas del server (el `homey-app log` solo sirve para sesiones dev). La CLI 4.4 no tiene `homey app log`.
4. **Build de diagnóstico**: trampa `uncaughtException`/`unhandledRejection` + hitos (`[boot]`, `[onInit]`, `[driver]`, `[device]`) reportados por HTTP a un listener en la Pi (`/tmp/crashcatch.py` → `/tmp/devices-crash.log`, puerto 9999). Reporter en `lib/diag.js`, marcado "DIAGNÓSTICO TEMPORAL".
5. Resultado del diagnóstico: **TODO inicializa OK en modo instalado** — app, driver y los 4 devices (`onInit OK` de cada uno). Pero Homey seguía reportando `available: false`.
6. **Conclusión**: desync del core de Homey — tras el ciclo de desinstalación (por el uninstall-on-quit) + reinstalación, los devices re-adoptados quedan con el flag de disponibilidad apagado aunque el init sea exitoso. Nuestro código nunca llamaba `setAvailable()` (normalmente no hace falta).

## Fix aplicado (commit e57e011)

`await this.setAvailable().catch(this.error)` al final del `onInit` del device (device.js). Inocuo en el caso normal, corrige el desync en la re-adopción.

## Reglas operativas que dejó este episodio

- **NUNCA usar `homey-app stop` sobre una sesión dev si se quiere conservar la app instalada**: el quit desinstala TODO (app + settings de app). Para actualizar una instalación: `homey-app update <app> --no-install` + `homey-app install <app> --last` (sin pasar por run/stop).
- `run` es SOLO para debug puntual, sabiendo que al frenarlo hay que reinstalar y reconfigurar los settings de app.
- Los settings de app (IP del PHM) se pierden con la desinstalación → tras un ciclo run/stop hay que re-configurarlos (pantalla de configuración de la app) o dar de alta un device (el wizard los siembra).
- Para inspeccionar el estado real del Homey sin logs: **HomeyScript web** (my.homey.app → ícono `</>`): `Homey.apps.getApp({id})`, `Homey.devices.getDevice({id})` (campos `available`, `unavailableMessage`, `origin: devkit_run|devkit_install`). Developer Tools → App Performance muestra si la app realmente corre.

## Resultado del fix (2026-07-16, cierre de sesión)

Con `setAvailable()` desplegado: el boot completo reporta OK (app + driver + 4 devices `onInit OK`), `setAvailable()` no tira error… **y los devices siguen `available: false`**. Conclusión refinada: el registro de devices del core quedó vinculado a una **sesión zombie** de la app (por los ciclos run→uninstall→install del mismo día) y ni siquiera el `setAvailable()` del proceso vivo lo pisa.

## Intentos intermedios descartados (2026-07-16, 2ª sesión)

Antes de reiniciar el Homey completo probé palancas menos invasivas — **ninguna funcionó**:
- **Reiniciar SOLO la app** (Ajustes → app → Reiniciar): los 4 devices siguen `available: false`. → El desync NO está en el proceso de la app; está en el registro de devices del core.
- **disable/enable de la app por HomeyScript** (`Homey.apps.disableApp/enableApp`): bloqueado, `Missing Scopes`.
- **Toggle "Activado" en la UI de la app**: no deja apagarlo (vuelve solo a ON — permisos).

Conclusión: agotadas las vías de software desde afuera. **Falta reiniciar el Homey completo** (única palanca que toca el registro del core).

## Pendiente al retomar (EN ORDEN)

1. **Reiniciar el Homey San Fran** (Fernán: app → Ajustes → General → Reiniciar; o vía HomeyScript `Homey.system.reboot()`). Tras el reboot, verificar disponibilidad de los 4 aires (script de abajo). La hipótesis fuerte es que el reboot limpia el desync.
2. Si tras el reboot siguen no disponibles: plan C — borrar y re-crear los devices con el wizard (se pierde la config por device: entidad remote, code, funciones; son 2 minutos por aire), o investigar el binding con Athom.
3. **Revertir el diagnóstico temporal**: quitar `lib/diag.js` y las líneas "DIAGNÓSTICO TEMPORAL" en `app.js`, `drivers/ac/driver.js`, `drivers/ac/device.js` (el `setAvailable()` SÍ queda — robustez). Matar el listener en la Pi (`pkill -f crashcatch.py`) y borrar `/tmp/crashcatch.py` y `/tmp/devices-crash.log`.
4. **Verificar/re-configurar settings de app en San Fran** (IP del PHM `192.168.88.101` — se pierden con cada desinstalación).
5. Redeployar la versión limpia a los 3 Homeys (`update --no-install` + `install` en ferno, jx y segun — NUNCA más run/stop sobre instalaciones).

Script de verificación (HomeyScript web, my.homey.app → `</>`):
```js
const ids = { Escritorio: '642da637-a06a-4564-a819-f1b270f41a89', Estar: 'ddbf5fbe-47a5-44e2-85be-ea345e7e9fd5', Cocina: 'eedd6d69-d086-40d8-910e-6277a41b11fd', Cuarto: 'b065956c-c7da-41af-8a6f-51279d4dba50' };
for (const [n, id] of Object.entries(ids)) { const d = await Homey.devices.getDevice({ id }); log(`${n}: available=${d.available}`); }
```

## IDs útiles (San Fran)

- Aire Escritorio `642da637-a06a-4564-a819-f1b270f41a89` · Aire Estar `ddbf5fbe-47a5-44e2-85be-ea345e7e9fd5` · Aire Cocina `eedd6d69-d086-40d8-910e-6277a41b11fd` · Aire Cuarto `b065956c-c7da-41af-8a6f-51279d4dba50`
- Homey San Fran: `65bf7e0855f8146a5637bcc0` (my.homey.app), IP `192.168.88.100`. PHM/Pi: `192.168.88.101`.
