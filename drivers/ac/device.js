'use strict';

const Homey = require('homey');
const { SWING_POSITIONS } = require('../../lib/ir-codes');
const { decide: decideDetectedMode } = require('../../lib/state-mirror');

const MS_PER_HOUR = 3600000;
// Auto-apagado (def. 28): tope del slider cuando lo maneja la app (en modo IR
// manda la planilla). Configurable por equipo en Avanzado.
const AUTO_OFF_DEFAULT_MAX_H = 12;
// Margen para ejecutar un auto-apagado que venció mientras la app estaba
// reiniciando (deploy, reboot). Más viejo que esto no se dispara: el equipo
// pudo haberse usado en el medio.
const AUTO_OFF_GRACE_MS = 5 * 60 * 1000;

// Espejo de estado real (def. 29).
// La aleta aletea al arrancar y al frenar: se exige que el contacto quede
// quieto antes de creerle.
const FLAP_DEBOUNCE_MS = 30 * 1000;
// Tras un comando PROPIO la aleta se mueve por lo que mandamos nosotros, no
// por una acción externa: en esa ventana el tile ya está bien y no se toca.
const OWN_COMMAND_SETTLE_MS = 3 * 60 * 1000;
// El serpentín tarda en tomar temperatura y el cuarto más todavía: la
// evidencia buena para decidir frío/calor recién existe unos minutos después.
const MODE_EVAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Aire acondicionado Pantea. Orquesta las reglas de negocio (definiciones
 * 1–20 de docs/rediseno-app.md) y delega en los servicios de la app:
 * ir-codes (planilla), command-sender (envío) y telegram (avisos).
 *
 * Regla de reversión (def. 10): si el envío falla definitivamente, el
 * listener LANZA → Homey no aplica el valor en la UI (revert automático).
 * Las capabilities acompañantes (ej. onoff al cambiar el modo) se setean
 * recién DESPUÉS de un envío exitoso.
 */
class AcDevice extends Homey.Device {

  async onInit() {
    this.log('AC inicializado:', this.getName());

    this._learning = false;
    this._lastMode = (await this.getStoreValue('last_mode')) || 'cool';
    // Banner del tile: `setWarning` es el ÚNICO banner que expone el SDK (no
    // hay uno "de éxito"), así que lo comparten el aviso de comando faltante
    // (def. 23) y el del apagado automático programado (def. 28) — el estado
    // vive acá para que `_refreshBanner` sea el único que lo escribe.
    this._lastMissing = [];
    this._autoOffUntil = null;
    this._autoOffTimeout = null;
    this._autoOffStepH = 0.5;
    // Espejo de estado real (def. 29).
    this._flapState = null;
    this._flapDebounce = null;
    this._modeEvalTimeout = null;
    this._roomTempAtStart = null;
    this._lastOwnCommandAt = 0;

    if (this.getCapabilityValue('onoff') === null) {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    // measure_temperature solo si hay device fuente (def. 9): presencia de
    // la capability + suscripción al device fuente vía HomeyAPI.
    await this._syncTempCapability().catch(this.error);
    this._attachTempMirror();

    // Estado real del equipo desde el sensor de aleta (def. 29).
    this._attachStateMirror();

    // Funciones permitidas del equipo (def. 21): presencia de capabilities
    // y modos visibles según settings.
    await this._syncAllowedFeatures().catch(this.error);

    // Migración (def. 26): button.reconnect se agregó al manifest después de
    // que se crearan los primeros devices. Homey NO añade capabilities nuevas
    // a los devices existentes → hay que agregarlo a mano para que aparezca
    // "Reconectar control" en Mantenimiento.
    if (!this.hasCapability('button.reconnect')) {
      await this.addCapability('button.reconnect').catch(this.error);
    }

    // Label informativo de la IP del PHM en los settings del tile (def. 24):
    // muestra el valor a nivel app y se refresca si cambia.
    this._syncPhmInfo();
    this._phmSettingsListener = (key) => {
      if (key === 'phm_host' || key === 'phm_port') this._syncPhmInfo();
    };
    this.homey.settings.on('set', this._phmSettingsListener);

    this.registerCapabilityListener('onoff', (value) => this._onOnOff(value));
    this.registerCapabilityListener('thermostat_mode', (value) => this._onMode(value));
    this.registerCapabilityListener('target_temperature', (value) => this._onTemperature(value));
    this.registerCapabilityListener('fan_mode', (value) => this._onFanOrSleep('fan', value));
    this.registerCapabilityListener('sleep_on_off', (value) => this._onFanOrSleep('sleep', value));
    // Swing según tipo (def. 5 v3): el tile tiene UNA de las dos capabilities.
    this.registerCapabilityListener('swing_on_off', (value) => this._onSwing(value === true ? 'on' : 'off'));
    this.registerCapabilityListener('swing_mode', (value) => this._onSwing(value));
    this.registerCapabilityListener('auto_off', (value) => this._onAutoOff(value));
    this.registerCapabilityListener('learning_mode', (value) => this._onLearning(value));
    this.registerCapabilityListener('button.reload_codes', () => this._onReloadCodes());
    this.registerCapabilityListener('button.reconnect', () => this._onReconnect());

    // Auto-apagado en curso al arrancar (def. 28): el vencimiento vive en
    // store, así que sobrevive a reinicios de la app.
    await this._restoreAutoOff().catch(this.error);

    // Disponibilidad explícita: tras un ciclo de desinstalación/reinstalación
    // (p. ej. el uninstall-on-quit de homey app run), Homey puede dejar el
    // device marcado como no disponible aunque el init haya sido exitoso.
    await this.setAvailable().catch(this.error);
  }

  // -------------------- listeners --------------------

  /** On/off (def. 1): prender restaura el último modo; los demás valores son los vigentes del tile. */
  async _onOnOff(value) {
    if (value) {
      const mode = (this._lastMode && this._lastMode !== 'off') ? this._lastMode : 'cool';
      await this._dispatch(this._state({ mode }), 'mode');
      await this._setCompanion('thermostat_mode', mode);
      await this._swingAfterPowerOn();
    } else {
      await this._dispatch(this._state({ mode: 'off' }), 'mode');
      await this._setCompanion('thermostat_mode', 'off');
    }
    return true;
  }

  async _onMode(value) {
    // Red de seguridad def. 21: modos no permitidos se rechazan aunque el
    // filtrado del picker (setCapabilityOptions) no esté disponible.
    this._assertModeAllowed(value);
    const previousMode = this.getCapabilityValue('thermostat_mode') || 'off';
    if (value !== 'off') {
      this._lastMode = value;
      await this.setStoreValue('last_mode', value).catch(this.error);
    }
    await this._dispatch(this._state({ mode: value }), 'mode');
    await this._setCompanion('onoff', value !== 'off');
    if (value !== 'off' && previousMode === 'off') {
      await this._swingAfterPowerOn();
    }
    return true;
  }

  /** Temperatura (def. 1): apagado + auto_on → enciende al último modo; apagado sin auto_on → queda en el tile. */
  async _onTemperature(value) {
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'off';

    if (currentMode === 'off' && !this._learning) {
      if (!this.getSetting('auto_on')) {
        this.log(`Apagado sin auto-on: temperatura ${value}° queda en el tile y se aplica al prender.`);
        return true;
      }
      const mode = (this._lastMode && this._lastMode !== 'off') ? this._lastMode : 'cool';
      await this._dispatch(this._state({ mode, temp: value }), 'mode'); // encendido ⇒ aplica 2 pasos
      await this._setCompanion('thermostat_mode', mode);
      await this._setCompanion('onoff', true);
      await this._swingAfterPowerOn();
      return true;
    }

    await this._dispatch(this._state({ temp: value }), 'temperature');
    return true;
  }

  async _onFanOrSleep(trigger, value) {
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'off';
    if (currentMode === 'off' && !this._learning) {
      this.log(`Apagado: cambio de ${trigger} queda en el tile, no se envía.`);
      return true;
    }
    const overrides = trigger === 'fan' ? { fan: value } : { sleep: value ? 'on' : 'off' };
    await this._dispatch(this._state(overrides), trigger);
    this._triggerFlow(trigger, value);
    return true;
  }

  /**
   * Swing (def. 5 v3): comando propio por clave — 'on'/'off' (tipo on/off) o
   * posición (tipo por posición) — solo si la planilla tiene el código. Con
   * learning activo, aprende esa clave.
   */
  async _onSwing(key) {
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'off';
    if (currentMode === 'off' && !this._learning) {
      this.log('Apagado: swing queda en el tile, no se envía.');
      return true;
    }

    const sender = this.homey.app.commandSender;
    let result;
    if (this._learning) {
      result = await sender.sendSwingLearn(this._config(), key);
      this._learning = false;
      await this.setCapabilityValue('learning_mode', false).catch(this.error);
    } else {
      result = await sender.sendSwing(this._config(), key);
    }

    if (!result.ok) return this._failure(result);
    if (result.remoteDown) return this._warnRemoteDown(result.reason);
    await this._warnMissing(result.missing);
    if (result.skipped) {
      // Sin código no se envió NADA al equipo: el estado queda solo en el
      // tile, así que tampoco corresponde disparar la flow card de cambio.
      this.log(`Swing ${key} sin código en la planilla: solo queda el estado en el tile.`);
      return true;
    }
    // El swing es otra trama IR completa: en modo 'ir' también pisa el
    // temporizador del equipo (def. 28).
    await this._autoOffAfterCommand();
    this._triggerFlow('swing', key);
    return true;
  }

  /**
   * Apagado automático (def. 28). El slider son horas restantes; 0 = sin
   * temporizador. Según el setting `auto_off_mode`:
   *   'device' → lo cuenta la app y al vencer manda el comando de apagado.
   *   'ir'     → se manda AHORA el código `timer_off_XX` de la planilla y el
   *              equipo se apaga solo; la cuenta del slider es un reflejo.
   * Con learning activo se aprende la clave, igual que el swing.
   */
  async _onAutoOff(value) {
    const hours = Number(value) || 0;
    const mode = this._autoOffMode();

    // Solo hay algo que aprender en modo 'ir': en modo 'device' el
    // temporizador es de la app, no del equipo — mover el slider no consume
    // la sesión de learning.
    if (this._learning && mode === 'ir') {
      const config = this._config();
      const scope = config.learnTimerScope;
      // Con barrido no importa qué tiempo se movió en el slider: el servidor
      // recorre la lista entera. Solo el alcance "tiempo específico" necesita
      // un valor concreto.
      if (scope === 'single' && hours <= 0) {
        throw new Error(this.homey.__({
          en: 'Pick a time greater than 0 to learn it.',
          es: 'Elegí un tiempo mayor a 0 para aprenderlo.',
        }));
      }
      const result = await this.homey.app.commandSender.sendTimerLearn(config, hours);
      this._learning = false;
      await this.setCapabilityValue('learning_mode', false).catch(this.error);
      if (!result.ok) return this._failure(result);
      this.log(scope === 'single'
        ? `Learning del apagado automático de ${hours} h enviado.`
        : `Learning del apagado automático enviado (barrido ${scope}).`);
      return true;
    }

    if (hours <= 0) {
      await this._cancelAutoOff({ sendToUnit: mode === 'ir' });
      return true;
    }

    // La flow card acepta hasta 24 h, pero el tope real lo fija el equipo
    // (setting en modo 'device', planilla en modo 'ir'): mejor un error claro
    // que un contador corriendo con el slider fuera de rango.
    const max = Number((this.getCapabilityOptions('auto_off') || {}).max) || AUTO_OFF_DEFAULT_MAX_H;
    if (hours > max) {
      const top = this._hoursText(max);
      throw new Error(this.homey.__({
        en: `The longest auto-off for this unit is ${top.en}.`,
        es: `El apagado automático más largo de este equipo es de ${top.es}.`,
      }));
    }

    // Programar un apagado sobre un equipo apagado no tiene sentido: se
    // rechaza (a diferencia de fan/sleep, que sí se guardan para el próximo
    // encendido, un temporizador no se puede "aplicar más tarde").
    if ((this.getCapabilityValue('thermostat_mode') || 'off') === 'off') {
      throw new Error(this.homey.__({
        en: 'The unit is off: turn it on before scheduling the auto-off.',
        es: 'El equipo está apagado: prendelo antes de programar el apagado automático.',
      }));
    }

    if (mode === 'ir') {
      const result = await this.homey.app.commandSender.sendTimer(this._config(), hours);
      if (!result.ok) return this._failure(result);
      if (result.remoteDown) return this._warnRemoteDown(result.reason);
      if (result.skipped) {
        // A diferencia del swing (def. 5), acá el valor NO queda en el tile:
        // una cuenta regresiva corriendo sin que el equipo haya recibido nada
        // le miente al usuario. Se revierte con el motivo.
        const time = this._hoursText(hours);
        throw new Error(this.homey.__({
          en: `This unit has no auto-off of ${time.en} learned.`,
          es: `Este equipo no tiene aprendido el apagado automático de ${time.es}.`,
        }));
      }
    }

    await this._startAutoOff(hours);
    this._triggerFlow('auto_off', hours);
    return true;
  }

  /** Learning (def. 7): botón por device; queda activo hasta el primer comando. */
  async _onLearning(value) {
    this._learning = value === true;
    this.log('Modo learning:', this._learning);
    return true;
  }

  /** Maintenance action "recargar códigos" (def. 18). */
  async _onReloadCodes() {
    const { code } = this._config();
    if (!code) {
      throw new Error(this.homey.__({
        en: 'This device has no code sheet code configured.',
        es: 'Este equipo no tiene code de planilla configurado.',
      }));
    }
    await this.homey.app.irCodes.reload(code);
    this.log(`Códigos del code ${code} recargados de la planilla.`);
    return true;
  }

  /** Maintenance action "Reconectar control" (def. 26): recarga el Broadlink en el PHM. */
  async _onReconnect() {
    const config = this._config();
    if (!config.haToken) {
      throw new Error(this.homey.__({
        en: 'This action needs the Pantea Home Manager token (app settings).',
        es: 'Esta acción necesita el token de Pantea Home Manager (configuración de la app).',
      }));
    }
    const result = await this.homey.app.commandSender.reloadBroadlink(config);
    if (!result.ok) {
      // Mismos motivos/mensajes que el envío de comandos (pedido Fernán
      // 2026-07-19: el botón tiene que dar el mismo detalle).
      const entityFull = this._entityFull();
      const byReason = {
        remote_not_found: {
          en: `The entity ${entityFull || '(not set)'} was not found in Pantea Home Manager. Check the device settings.`,
          es: `No se encuentra la entidad ${entityFull || '(sin configurar)'} en Pantea Home Manager. Revisá la configuración del equipo.`,
        },
        no_connection: {
          en: 'No connection to Pantea Home Manager. Check it is powered on and on the network.',
          es: 'No hay conexión con Pantea Home Manager. Revisá que esté encendido y en la red.',
        },
        token_rejected: {
          en: 'The Pantea Home Manager token was rejected. Check the app settings.',
          es: 'El token de Pantea Home Manager fue rechazado. Revisá la configuración de la app.',
        },
        reload_failed: {
          en: `Could not reconnect the control${entityFull ? ` (${entityFull})` : ''}. Check its power/Wi-Fi.`,
          es: `No se pudo reconectar el control${entityFull ? ` (${entityFull})` : ''}. Revisá su energía/Wi-Fi.`,
        },
      };
      throw new Error(this.homey.__(byReason[result.reason] || byReason.reload_failed));
    }
    await this.setWarning(null).catch(() => {});
    this.log('Reconexión del control solicitada al PHM.');
    return true;
  }

  // -------------------- núcleo de envío --------------------

  /**
   * Envía estado o learning según el modo del device. Con learning activo,
   * el comando va a ac_learn y el botón se apaga (defs. 7 y 16).
   */
  async _dispatch(state, trigger) {
    const sender = this.homey.app.commandSender;
    const config = this._config();
    // Marca para el espejo de aleta (def. 29): lo que se mueva a partir de acá
    // lo causamos nosotros, no una acción externa.
    this._lastOwnCommandAt = Date.now();

    let result;
    if (this._learning) {
      result = await sender.sendLearn(config, state, trigger);
      this._learning = false;
      await this.setCapabilityValue('learning_mode', false).catch(this.error);
    } else {
      result = await sender.sendState(config, state, trigger);
    }

    if (!result.ok) return this._failure(result);
    if (result.remoteDown) return this._warnRemoteDown(result.reason);
    await this._warnMissing(result.missing);
    await this._autoOffAfterCommand({ goesOff: state.mode === 'off' });
    return result;
  }

  /**
   * Feedback unificado de falla (def. 26 rev. 2026-07-18): banner persistente
   * (transición null→texto para re-emitir en cada envío fallido, no solo al
   * reabrir el tile) + Telegram con detalle + notificación en el timeline de
   * Homey (campanita). NO lanza: el caller decide si revierte.
   */
  async _notifyFail(message, detail) {
    await this.setWarning(null).catch(() => {});
    await this.setWarning(message).catch(() => {});
    this.homey.app.telegram.notifyFailure(
      this.getName(),
      message + (detail ? ` (${detail})` : ''),
    ).catch(this.error);
    this.homey.notifications.createNotification({
      excerpt: `⚠️ ${this.getName()}: ${message}`,
    }).catch(this.error);
  }

  /**
   * Def. 26 (rev. 2026-07-18): HA recibió el comando pero el control IR no
   * respondió → el aire físico NO cambió, así que revertimos (throw) con un
   * mensaje según el motivo que devolvió el script:
   *   remote_not_found   → la entidad remote no existe en el PHM.
   *   remote_unavailable → la entidad existe pero está sin conexión.
   */
  /**
   * Entidad remote completa (remote.X) para mensajes: el setting guarda el
   * nombre pelado; acá se normaliza igual que command-sender al enviar.
   */
  _entityFull() {
    const { remoteEntity } = this._config();
    if (!remoteEntity) return '';
    return remoteEntity.startsWith('remote.') ? remoteEntity : `remote.${remoteEntity}`;
  }

  async _warnRemoteDown(reason) {
    const entityFull = this._entityFull();
    const entity = entityFull ? ` (${entityFull})` : '';
    const byReason = {
      remote_not_found: {
        en: `The entity ${entityFull || '(not set)'} was not found in Pantea Home Manager. Check the device settings.`,
        es: `No se encuentra la entidad ${entityFull || '(sin configurar)'} en Pantea Home Manager. Revisá la configuración del equipo.`,
      },
      remote_unavailable: {
        en: `The control is offline / not responding${entity}. Try "Reconnect control" (device settings) or check its power/Wi-Fi.`,
        es: `El control está sin conexión / no responde${entity}. Probá "Reconectar control" (config. del equipo) o revisá su energía/Wi-Fi.`,
      },
    };
    const message = this.homey.__(byReason[reason] || {
      en: `The remote control is not responding${entity}. The change was not applied.`,
      es: `El control no responde${entity}. El cambio no se aplicó.`,
    });
    await this._notifyFail(message, reason);
    // El listener LANZA → Homey revierte el valor (el "pegar la vuelta" es el
    // feedback visible principal).
    throw new Error(message);
  }

  /**
   * Aviso de comandos ausentes en la planilla (pedido de Fernán 2026-07-15):
   * con code configurado y clave inexistente, el envío sale igual por el
   * camino legacy, pero el tile muestra qué comando falta. Sin faltantes,
   * se limpia el warning.
   */
  async _warnMissing(missing) {
    this._lastMissing = Array.isArray(missing) ? missing : [];
    await this._refreshBanner();
  }

  /**
   * Único dueño del banner del tile: el faltante de planilla (def. 23) tiene
   * prioridad y, si no hay, se muestra el aviso del apagado automático
   * programado (def. 28). El SDK de Homey no expone un banner "de éxito"
   * (`Device` solo tiene `setWarning` y `setUnavailable`), así que el aviso en
   * verde que pedía el diseño va por el mismo canal amarillo, con ✅ adelante.
   */
  async _refreshBanner() {
    const missing = this._lastMissing || [];
    if (missing.length > 0) {
      await this.setWarning(this.homey.__({
        en: `Command not available in the code sheet: ${missing.join(', ')}`,
        es: `Comando no disponible en la planilla: ${missing.join(', ')}`,
      })).catch(() => {});
      return;
    }
    await this.setWarning(this._autoOffBanner()).catch(() => {});
  }

  _autoOffBanner() {
    if (this._autoOffUntil == null) return null;
    const left = this._hoursText(this._autoOffRemainingHours());
    if (this._autoOffMode() === 'ir') {
      return this.homey.__({
        en: `✅ Auto-off sent to the unit: it turns off in ${left.en}. It most likely beeped when it took the order.`,
        es: `✅ Apagado automático enviado al equipo: se apaga en ${left.es}. Es muy probable que haya hecho un beep al recibir la orden.`,
      });
    }
    return this.homey.__({
      en: `✅ Auto-off in ${left.en}: the off command will be sent then, and the unit will most likely beep.`,
      es: `✅ Apagado automático en ${left.es}: se va a enviar la orden de apagado y es muy probable que el equipo haga un beep.`,
    });
  }

  /**
   * Def. 10 (mensajes por motivo, rev. 2026-07-18): no se pudo enviar el
   * comando al PHM (falla de transporte). banner + Telegram + timeline + throw
   * (el throw revierte la UI). El motivo lo clasifica command-sender.
   */
  async _failure(result) {
    const reason = (result && result.reason) || 'no_connection';
    const detail = (result && result.error && result.error.message) || '';
    const byReason = {
      no_connection: {
        en: 'No connection to Pantea Home Manager. Check it is powered on and on the network.',
        es: 'No hay conexión con Pantea Home Manager. Revisá que esté encendido y en la red.',
      },
      service_missing: {
        en: 'The command service is not set up in Pantea Home Manager.',
        es: 'El servicio de comandos no está configurado en Pantea Home Manager.',
      },
      server_error: {
        en: 'Pantea Home Manager could not process the command (server error).',
        es: 'Pantea Home Manager no pudo procesar el comando (error del servidor).',
      },
      http_error: {
        en: 'Pantea Home Manager rejected the command.',
        es: 'Pantea Home Manager rechazó el comando.',
      },
    };
    const message = this.homey.__(byReason[reason] || byReason.no_connection);
    await this._notifyFail(message, detail);
    throw new Error(message);
  }

  /**
   * Def. 5, al prender: si la planilla tiene códigos de swing DISTINTOS para
   * las claves del equipo, se manda el del estado del tile después del
   * encendido. Si son iguales (toggle) o no existen, no se manda nada. No
   * revierte el encendido si falla: solo log.
   */
  async _swingAfterPowerOn() {
    try {
      const { code } = this._config();
      if (!code) return;
      const key = this._swingKey();
      if (!key) return;
      const commands = await this.homey.app.irCodes.getSwingCommands(code);
      // Solo las claves del TIPO de swing de este equipo: un code puede traer
      // los dos juegos (on/off y posiciones) y mezclarlos falsearía la
      // detección de toggle — un on/off con códigos iguales pasaría el
      // conteo gracias a una clave posicional que este tile ni usa.
      const ownKeys = this.hasCapability('swing_mode') ? SWING_POSITIONS : ['on', 'off'];
      const available = ownKeys.map((k) => commands[k]).filter((c) => c != null);
      // Hace falta más de un código distinto: con uno solo (o todos
      // repetidos = toggle) no se puede saber el estado real del equipo.
      if (new Set(available).size < 2) return;
      if (!commands[key]) return;
      const result = await this.homey.app.commandSender.sendSwing(this._config(), key);
      if (!result.ok) this.error('No se pudo reenviar swing tras el encendido:', result.error?.message);
      else if (result.remoteDown) this.log(`Swing tras el encendido: el control no respondió (${result.reason}).`);
    } catch (err) {
      this.error('Error en swing post-encendido:', err);
    }
  }

  // -------------------- apagado automático (def. 28) --------------------

  _autoOffMode() {
    return this.getSetting('auto_off_mode') || 'none';
  }

  /** Texto del tiempo en los dos idiomas (el español lleva coma decimal). */
  _hoursText(hours) {
    const plain = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return { en: `${plain} h`, es: `${plain.replace('.', ',')} h` };
  }

  /** Horas que corresponde mostrar en el slider, redondeadas hacia arriba al paso. */
  _autoOffRemainingHours() {
    if (this._autoOffUntil == null) return 0;
    const step = this._autoOffStepH || 0.5;
    const remaining = (this._autoOffUntil - Date.now()) / MS_PER_HOUR;
    if (remaining <= 0) return 0;
    return Math.round(Math.ceil(remaining / step) * step * 10) / 10;
  }

  /**
   * Máximo y paso del slider según el modo (def. 28). En modo IR los manda la
   * planilla: el tope es el tiempo más largo aprendido y, si son todos horas
   * enteras, el paso pasa a 1 (el slider no ofrece medias horas que el equipo
   * no sabe hacer).
   */
  async _syncAutoOffOptions(mode) {
    if (!this.hasCapability('auto_off')) return;
    let max = Number(this.getSetting('auto_off_max')) || AUTO_OFF_DEFAULT_MAX_H;
    let step = 0.5;

    if (mode === 'ir') {
      const hours = await this._learnedAutoOffHours();
      if (hours.length > 0) {
        max = Math.max(...hours);
        step = hours.every((h) => Number.isInteger(h)) ? 1 : 0.5;
      }
    }

    this._autoOffStepH = step;
    try {
      await this.setCapabilityOptions('auto_off', {
        min: 0, max, step, decimals: step === 1 ? 0 : 1,
      });
    } catch (err) {
      this.log('setCapabilityOptions(auto_off) no disponible:', err.message);
    }
    if (this.getCapabilityValue('auto_off') === null) {
      await this.setCapabilityValue('auto_off', 0).catch(this.error);
    }
  }

  async _learnedAutoOffHours() {
    const { code } = this._config();
    if (!code) return [];
    try {
      return await this.homey.app.irCodes.getTimerHours(code);
    } catch (err) {
      this.error('No se pudieron leer los tiempos de apagado automático:', err.message || err);
      return [];
    }
  }

  async _startAutoOff(hours) {
    this._autoOffUntil = Date.now() + Math.round(hours * MS_PER_HOUR);
    await this.setStoreValue('auto_off_until', this._autoOffUntil).catch(this.error);
    await this._setCompanion('auto_off', hours);
    this._scheduleAutoOffTick();
    await this._refreshBanner();
    this.log(`Apagado automático programado en ${hours} h (modo ${this._autoOffMode()}).`);
  }

  /**
   * Cancela el temporizador. `sendToUnit` (solo modo IR) manda además el
   * código de cancelar; si la planilla no lo tiene, no hay forma de anularlo
   * en el equipo y se avisa en vez de mentir.
   */
  async _cancelAutoOff({ sendToUnit = false } = {}) {
    const hadTimer = this._autoOffUntil != null;
    this._clearAutoOffTimeout();
    this._autoOffUntil = null;
    if (this.hasCapability('auto_off') && this.getCapabilityValue('auto_off') !== 0) {
      await this._setCompanion('auto_off', 0);
    }
    // Sin temporizador en curso no hay nada que anular: no se toca el banner
    // (lo llama `_syncAllowedFeatures` en cada arranque y borraría un aviso
    // de comando faltante ajeno).
    if (!hadTimer) return;
    await this.unsetStoreValue('auto_off_until').catch(this.error);

    if (sendToUnit) {
      const result = await this.homey.app.commandSender.sendTimer(this._config(), 0);
      if (!result.ok) return this._failure(result);
      if (result.remoteDown) return this._warnRemoteDown(result.reason);
      if (result.skipped) {
        await this.setWarning(this.homey.__({
          en: 'The auto-off was cleared here, but this unit has no "cancel timer" command learned: it may still turn itself off.',
          es: 'Se borró el apagado automático acá, pero este equipo no tiene aprendido el comando de cancelar: puede que se apague igual.',
        })).catch(() => {});
        return;
      }
    }
    await this._refreshBanner();
  }

  _clearAutoOffTimeout() {
    if (this._autoOffTimeout) {
      this.homey.clearTimeout(this._autoOffTimeout);
      this._autoOffTimeout = null;
    }
  }

  /** Despierta justo cuando el slider tiene que bajar un paso (no cada minuto). */
  _scheduleAutoOffTick() {
    this._clearAutoOffTimeout();
    if (this._autoOffUntil == null) return;
    const remaining = this._autoOffUntil - Date.now();
    if (remaining <= 0) {
      this._autoOffTimeout = this.homey.setTimeout(() => this._fireAutoOff().catch(this.error), 0);
      return;
    }
    const stepMs = (this._autoOffStepH || 0.5) * MS_PER_HOUR;
    const nextBoundary = (Math.ceil(remaining / stepMs) - 1) * stepMs;
    const delay = Math.max(remaining - nextBoundary, 1000);
    this._autoOffTimeout = this.homey.setTimeout(() => this._autoOffTick().catch(this.error), delay);
  }

  async _autoOffTick() {
    if (this._autoOffUntil == null) return;
    if (this._autoOffUntil - Date.now() <= 0) {
      await this._fireAutoOff();
      return;
    }
    await this._setCompanion('auto_off', this._autoOffRemainingHours());
    await this._refreshBanner();
    this._scheduleAutoOffTick();
  }

  /**
   * Vencimiento. En modo 'device' recién acá sale el comando de apagado; en
   * modo 'ir' el equipo ya se apagó solo, así que solo se pone el tile en off
   * sin enviar nada.
   */
  async _fireAutoOff() {
    this._clearAutoOffTimeout();
    const mode = this._autoOffMode();
    this._autoOffUntil = null;
    await this.unsetStoreValue('auto_off_until').catch(this.error);
    if (this.hasCapability('auto_off')) await this._setCompanion('auto_off', 0);

    if (mode === 'device') {
      try {
        await this._dispatch(this._state({ mode: 'off' }), 'mode');
      } catch (err) {
        // No lo disparó el usuario: no hay UI que revertir. `_dispatch` ya
        // avisó por banner + Telegram + timeline (defs. 10 y 26).
        this.error('No se pudo enviar el apagado automático:', err.message || err);
        return;
      }
    }

    await this._setCompanion('thermostat_mode', 'off');
    await this._setCompanion('onoff', false);
    await this._refreshBanner();
    this.driver.flowAutoOffFinished?.trigger(this, {}, {}).catch(this.error);
    this.log(`Apagado automático ejecutado (modo ${mode}).`);
  }

  /** Retoma un temporizador que quedó vivo en store al reiniciar la app. */
  async _restoreAutoOff() {
    const until = Number(await this.getStoreValue('auto_off_until')) || null;
    if (!this.hasCapability('auto_off')) {
      // Se deshabilitó el apagado automático con uno programado: que no
      // reviva si mañana lo vuelven a habilitar.
      if (until) await this.unsetStoreValue('auto_off_until').catch(this.error);
      return;
    }
    if (!until) {
      if (this.getCapabilityValue('auto_off') !== 0) await this._setCompanion('auto_off', 0);
      return;
    }
    this._autoOffUntil = until;

    if (Date.now() - until > AUTO_OFF_GRACE_MS) {
      this._autoOffUntil = null;
      await this.unsetStoreValue('auto_off_until').catch(this.error);
      await this._setCompanion('auto_off', 0);
      this.homey.notifications.createNotification({
        excerpt: `⚠️ ${this.getName()}: el apagado automático venció mientras la app estaba fuera de servicio y no se ejecutó.`,
      }).catch(this.error);
      return;
    }

    await this._setCompanion('auto_off', this._autoOffRemainingHours());
    this._scheduleAutoOffTick();
    await this._refreshBanner();
  }

  /**
   * Cualquier comando IR posterior invalida el temporizador: en modo 'ir'
   * porque el protocolo es stateful (la trama nueva pisa el temporizador del
   * equipo) y en los dos modos cuando el equipo queda apagado.
   */
  async _autoOffAfterCommand({ goesOff = false } = {}) {
    if (this._autoOffUntil == null) return;
    if (!goesOff && this._autoOffMode() !== 'ir') return;
    await this._cancelAutoOff();
    if (!goesOff) {
      await this.setWarning(this.homey.__({
        en: 'The auto-off was cleared: the new command sent to the unit replaces its timer.',
        es: 'Se borró el apagado automático: el comando nuevo enviado al equipo reemplaza su temporizador.',
      })).catch(() => {});
    }
  }

  // -------------------- estado real del equipo (def. 29) --------------------

  /** Suscripción (o baja) al sensor de aleta según los settings vigentes. */
  _attachStateMirror() {
    const mirror = this.homey.app.stateMirror;
    const contact = String(this.getSetting('flap_source') || '').trim();
    if (contact === '') {
      mirror.detach(this);
      this._cancelFlapTimers();
      this._flapState = null;
      return;
    }
    mirror.attach(this, {
      contact,
      inverted: this.getSetting('flap_inverted') === true,
      discharge: String(this.getSetting('discharge_temp_source') || '').trim(),
      outdoor: String(this.getSetting('outdoor_temp_source') || '').trim(),
    }).catch(this.error);
  }

  /**
   * Entrada desde el espejo: cambió el contacto de la aleta. Se aplica recién
   * cuando queda quieto (`FLAP_DEBOUNCE_MS`) — la aleta aletea al arrancar y
   * al frenar, y cada rebote no puede mover el tile.
   * @param {boolean} open true = aleta abierta = el equipo está funcionando
   */
  onFlapChanged(open) {
    if (this._flapState === open) return;
    if (this._flapDebounce) this.homey.clearTimeout(this._flapDebounce);
    this._flapDebounce = this.homey.setTimeout(
      () => this._applyFlap(open).catch(this.error),
      FLAP_DEBOUNCE_MS,
    );
  }

  async _applyFlap(open) {
    this._flapDebounce = null;
    this._flapState = open;

    // Ventana de asentamiento: si la aleta se movió por un comando NUESTRO, el
    // tile ya refleja lo que corresponde. Sin esto, el rato que tarda la aleta
    // en cerrarse tras un apagado se leería como "encendido externo".
    if (Date.now() - this._lastOwnCommandAt < OWN_COMMAND_SETTLE_MS) {
      this.log(`Aleta ${open ? 'abierta' : 'cerrada'} dentro de la ventana del último comando propio: se ignora.`);
      return;
    }

    if (!open) {
      this._cancelModeEval();
      if ((this.getCapabilityValue('thermostat_mode') || 'off') === 'off') return;
      await this._setDetected('off', 'flap');
      // Un apagado externo también deja sin sentido el apagado automático.
      await this._cancelAutoOff();
      return;
    }

    const tileMode = this.getCapabilityValue('thermostat_mode') || 'off';
    if (tileMode !== 'off') {
      // Ya sabíamos que estaba prendido y en qué modo: solo la evidencia
      // DECISIVA (sensor de descarga) puede corregirlo.
      this._scheduleModeEval({ allowHints: false });
      return;
    }

    // El tile estaba apagado y la aleta está abierta ⇒ lo prendieron con el
    // control físico. Se resuelve un modo provisorio con lo que haya ahora y
    // se reevalúa cuando el equipo tomó temperatura.
    this._roomTempAtStart = this._readRoomTemp();
    const temps = await this.homey.app.stateMirror.readTemps(this).catch(() => ({}));
    const { mode, reason } = decideDetectedMode({
      dischargeTemp: temps.discharge,
      roomTemp: this._readRoomTemp(),
      outdoorTemp: temps.outdoor,
      outdoorCutoff: Number(this.getSetting('outdoor_cutoff')) || 19,
      lastMode: this._lastMode,
    });
    await this._setDetected(mode || 'cool', mode ? reason : 'default');
    this._scheduleModeEval({ allowHints: true });
  }

  /**
   * Aplica un estado DETECTADO. Nunca envía IR: usa `_setCompanion`, que
   * escribe la capability sin pasar por su listener. Es el punto donde se
   * cumple el pedido "cuando lo setea no manda ninguna señal".
   */
  async _setDetected(modoDetectado, reason) {
    // Un modo inferido puede no existir en este equipo (def. 21): p. ej. la
    // temperatura de afuera dice "calor" en un aire que solo enfría. Se cae a
    // `cool`, que ningún setting puede deshabilitar.
    let mode = modoDetectado;
    if (mode !== 'off' && !this._isModeAllowed(mode)) {
      this.log(`Modo detectado ${mode} no habilitado en este equipo: se refleja como cool.`);
      mode = 'cool';
    }
    const previo = this.getCapabilityValue('thermostat_mode') || 'off';
    if (previo === mode) return;
    await this._setCompanion('thermostat_mode', mode);
    await this._setCompanion('onoff', mode !== 'off');
    if (mode !== 'off') {
      this._lastMode = mode;
      await this.setStoreValue('last_mode', mode).catch(this.error);
    }
    this.log(`Estado detectado sin enviar nada: ${previo} → ${mode} (${reason}).`);
    this.driver.flowStateDetected?.trigger(this, { mode: String(mode), reason: String(reason) }, {})
      .catch(this.error);
  }

  /**
   * Reevaluación del modo cuando ya hay evidencia buena. `allowHints` false =
   * el tile ya tiene un modo conocido y solo se acepta evidencia decisiva
   * (regla de seguridad de la def. 29).
   */
  _scheduleModeEval({ allowHints }) {
    this._cancelModeEval();
    this._modeEvalTimeout = this.homey.setTimeout(
      () => this._evaluateDetectedMode(allowHints).catch(this.error),
      MODE_EVAL_DELAY_MS,
    );
  }

  async _evaluateDetectedMode(allowHints) {
    this._modeEvalTimeout = null;
    if (this._flapState !== true) return; // se apagó mientras esperábamos
    const temps = await this.homey.app.stateMirror.readTemps(this).catch(() => ({}));
    const resultado = decideDetectedMode({
      dischargeTemp: temps.discharge,
      roomTemp: this._readRoomTemp(),
      roomTempAtStart: this._roomTempAtStart,
      outdoorTemp: temps.outdoor,
      outdoorCutoff: Number(this.getSetting('outdoor_cutoff')) || 19,
      lastMode: this._lastMode,
    });
    if (!resultado.mode) return;
    if (!resultado.decisive && !allowHints) {
      this.log(`Modo detectado (${resultado.reason}) descartado: el tile ya sabe el modo y el indicio no es evidencia decisiva.`);
      return;
    }
    await this._setDetected(resultado.mode, resultado.reason);
  }

  _readRoomTemp() {
    if (!this.hasCapability('measure_temperature')) return null;
    const value = this.getCapabilityValue('measure_temperature');
    return typeof value === 'number' ? value : null;
  }

  _cancelModeEval() {
    if (this._modeEvalTimeout) {
      this.homey.clearTimeout(this._modeEvalTimeout);
      this._modeEvalTimeout = null;
    }
  }

  _cancelFlapTimers() {
    if (this._flapDebounce) {
      this.homey.clearTimeout(this._flapDebounce);
      this._flapDebounce = null;
    }
    this._cancelModeEval();
  }

  // -------------------- estado y config --------------------

  _config() {
    const settings = this.getSettings();
    // IP/puerto del PHM viven a nivel APP (def. 24, un solo lugar). Fallback
    // a los settings viejos del device para instalaciones previas al cambio.
    const appHost = String(this.homey.settings.get('phm_host') || '').trim();
    const appPort = Number(this.homey.settings.get('phm_port')) || 8123;
    const legacyHost = String(settings.phm_host || '').trim();
    const legacyPort = Number(settings.phm_port) || 8123;
    return {
      host: appHost || legacyHost,
      port: appHost !== '' ? appPort : legacyPort,
      remoteEntity: (settings.remote_entity || '').trim(),
      code: String(settings.code ?? '').trim(),
      twoStepOverride: settings.two_step_override || 'auto',
      learnedFanOverride: settings.learned_fan_override || 'auto',
      allowSleep: settings.allow_sleep !== false,
      allowFanSpeed: settings.allow_fan_speed !== false,
      learnTempScope: settings.learn_temp_scope || 'range',
      learnTimerScope: settings.learn_timer_scope || 'range',
      // Token de HA a nivel app (def. 26): habilita el feedback del remote
      // (return_response) y el botón Reconectar. Vacío = webhook clásico.
      haToken: String(this.homey.settings.get('ha_token') || '').trim(),
    };
  }

  _state(overrides = {}) {
    const cap = (id) => (this.hasCapability(id) ? this.getCapabilityValue(id) : null);
    return {
      mode: overrides.mode ?? cap('thermostat_mode') ?? 'off',
      fan: overrides.fan ?? cap('fan_mode') ?? 'auto',
      temp: overrides.temp ?? cap('target_temperature') ?? 24,
      sleep: overrides.sleep ?? (cap('sleep_on_off') === true ? 'on' : 'off'),
    };
  }

  /** Dispara las flow cards propias tras un cambio exitoso (def. 19). */
  _triggerFlow(kind, value) {
    const { driver } = this;
    try {
      if (kind === 'fan') {
        driver.flowFanSpeedChanged?.trigger(this, { speed: String(value) }, {}).catch(this.error);
      } else if (kind === 'swing') {
        driver.flowSwingChanged?.trigger(this, { swing: String(value) }, {}).catch(this.error);
      } else if (kind === 'sleep') {
        const card = value ? driver.flowSleepOn : driver.flowSleepOff;
        card?.trigger(this, {}, {}).catch(this.error);
      } else if (kind === 'auto_off') {
        driver.flowAutoOffSet?.trigger(this, { hours: Number(value) }, {}).catch(this.error);
      }
    } catch (err) {
      this.error('No se pudo disparar la flow card:', err);
    }
  }

  /** Clave de swing vigente en el tile según el tipo configurado (def. 5 v3). */
  getSwingKey() {
    return this._swingKey();
  }

  /** ¿Hay un apagado automático corriendo? (condition card, def. 28). */
  isAutoOffActive() {
    return this._autoOffUntil != null && this._autoOffUntil > Date.now();
  }

  _swingKey() {
    if (this.hasCapability('swing_mode')) {
      return this.getCapabilityValue('swing_mode');
    }
    if (this.hasCapability('swing_on_off')) {
      return this.getCapabilityValue('swing_on_off') === true ? 'on' : 'off';
    }
    return null;
  }

  /** ¿El equipo tiene habilitado este modo? (def. 21) */
  _isModeAllowed(mode) {
    const settings = this.getSettings();
    if (mode === 'heat') return settings.allow_heat !== false;
    if (mode === 'dry') return settings.allow_dry !== false;
    if (mode === 'fan') return settings.allow_fan_mode !== false;
    return true;
  }

  _assertModeAllowed(mode) {
    if (!this._isModeAllowed(mode)) {
      throw new Error(this.homey.__({
        en: 'This unit does not support that mode.',
        es: 'Este equipo no permite ese modo.',
      }));
    }
  }

  /**
   * Def. 21: sincroniza capabilities y modos visibles con las funciones
   * permitidas del equipo.
   */
  async _syncAllowedFeatures() {
    const settings = this.getSettings();

    const syncCap = async (capability, allowed) => {
      if (allowed && !this.hasCapability(capability)) await this.addCapability(capability);
      else if (!allowed && this.hasCapability(capability)) await this.removeCapability(capability);
    };
    await syncCap('sleep_on_off', settings.allow_sleep !== false);
    await syncCap('fan_mode', settings.allow_fan_speed !== false);

    // Apagado automático (def. 28): el slider existe solo si el equipo lo
    // tiene habilitado en alguno de los dos modos.
    const autoOffMode = settings.auto_off_mode || 'none';
    await syncCap('auto_off', autoOffMode !== 'none');
    if (autoOffMode === 'none') {
      // Si se deshabilita con un temporizador corriendo, quedaría contando sin
      // slider (y en modo 'device' apagaría el equipo sin aviso).
      await this._cancelAutoOff();
    } else {
      await this._syncAutoOffOptions(autoOffMode);
    }

    // Learning (def. 7, rev. 2026-07-18): el botón "Aprender" es tarea del
    // instalador. Solo se muestra si NO hay code de planilla configurado; con
    // code, el usuario final nunca lo ve.
    const hasCode = String(settings.code ?? '').trim() !== '';
    // Si el botón desaparece con el learning prendido (se cargó un code sin
    // haber mandado ningún comando), el modo quedaría activo SIN forma de
    // apagarlo: el próximo comando se iría a ac_learn y el aire no respondería.
    if (hasCode && this._learning) {
      this._learning = false;
      this.log('Learning cancelado: el equipo pasó a tener code de planilla.');
    }
    await syncCap('learning_mode', !hasCode);

    // Swing (def. 5 v3): 'onoff' → toggle, 'positions' → picker,
    // 'none' → sin control de swing en el tile.
    const swingType = settings.swing_type || 'onoff';
    await syncCap('swing_mode', swingType === 'positions');
    await syncCap('swing_on_off', swingType === 'onoff');

    // Filtrado del picker de modos por device. setCapabilityOptions con
    // `values` puede no estar soportado en todas las versiones: si falla,
    // queda la red de seguridad de _assertModeAllowed().
    const allValues = [
      { id: 'off', title: { en: 'Off', es: 'Apagado' } },
      { id: 'auto', title: { en: 'Auto', es: 'Auto' } },
      { id: 'cool', title: { en: 'Cool', es: 'Frío' } },
      { id: 'heat', title: { en: 'Heat', es: 'Calor' } },
      { id: 'dry', title: { en: 'Dry', es: 'Secado' } },
      { id: 'fan', title: { en: 'Fan', es: 'Ventilador' } },
    ];
    const values = allValues.filter(({ id }) => {
      if (id === 'heat') return settings.allow_heat !== false;
      if (id === 'dry') return settings.allow_dry !== false;
      if (id === 'fan') return settings.allow_fan_mode !== false;
      return true;
    });
    try {
      await this.setCapabilityOptions('thermostat_mode', { values });
    } catch (err) {
      this.log('setCapabilityOptions(thermostat_mode) no disponible, queda la validación en listener:', err.message);
    }
  }

  /** Setea una capability acompañante sin pasar por su listener (post-éxito). */
  async _setCompanion(capability, value) {
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async _syncTempCapability() {
    const hasSource = String(this.getSetting('temp_source') || '').trim() !== '';
    if (hasSource && !this.hasCapability('measure_temperature')) {
      await this.addCapability('measure_temperature');
    } else if (!hasSource && this.hasCapability('measure_temperature')) {
      await this.removeCapability('measure_temperature');
    }
  }

  /** Refresca el label de solo lectura con la IP del PHM a nivel app (def. 24). */
  _syncPhmInfo() {
    const { host, port } = this._config();
    const info = host !== ''
      ? `${host}:${port}`
      : this.homey.__({ en: 'Not configured', es: 'Sin configurar' });
    if (this.getSetting('phm_host_info') === info) return;
    this.setSettings({ phm_host_info: info }).catch(this.error);
  }

  /** Suscripción (o baja) al device fuente según el setting vigente. */
  _attachTempMirror() {
    const source = String(this.getSetting('temp_source') || '').trim();
    const mirror = this.homey.app.tempMirror;
    if (source === '') {
      mirror.detach(this);
      return;
    }
    mirror.attach(this, source).catch(this.error);
  }

  // -------------------- settings --------------------

  async onDeleted() {
    this.homey.app.tempMirror?.detach(this);
    this.homey.app.stateMirror?.detach(this);
    this._cancelFlapTimers();
    this._clearAutoOffTimeout();
    if (this._phmSettingsListener) this.homey.settings.removeListener('set', this._phmSettingsListener);
  }

  async onUninit() {
    this.homey.app.tempMirror?.detach(this);
    this.homey.app.stateMirror?.detach(this);
    this._cancelFlapTimers();
    // El vencimiento queda en store: `_restoreAutoOff` lo retoma al arrancar.
    this._clearAutoOffTimeout();
    if (this._phmSettingsListener) this.homey.settings.removeListener('set', this._phmSettingsListener);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings cambiados:', changedKeys.join(', '));

    if (changedKeys.includes('code')) {
      const code = String(newSettings.code ?? '').trim();
      if (code !== '' && !/^\d+$/.test(code)) {
        throw new Error(this.homey.__({
          en: 'The code must be a number (or empty).',
          es: 'El code debe ser un número (o vacío).',
        }));
      }
    }

    if (changedKeys.includes('remote_entity')) {
      const remote = String(newSettings.remote_entity ?? '').trim();
      if (remote !== remote.toLowerCase()) {
        throw new Error(this.homey.__({
          en: 'The remote entity must be all lowercase (e.g. "living", not "Living").',
          es: 'La entidad remote va siempre en minúsculas (ej: "living", no "Living").',
        }));
      }
    }

    if (changedKeys.includes('temp_source')) {
      // Def. 9: si se carga un nombre, tiene que ser un device real con
      // measure_temperature — si no, se rechaza el cambio.
      const source = String(newSettings.temp_source || '').trim();
      if (source !== '') {
        const found = await this.homey.app.tempMirror.findSourceByName(source)
          .catch(() => undefined); // HomeyAPI caída: no validar (undefined ≠ null)
        if (found === null) {
          throw new Error(this.homey.__({
            en: `No device named "${source}" with temperature was found.`,
            es: `No se encontró un dispositivo "${source}" con temperatura.`,
          }));
        }
      }
      this.homey.setTimeout(() => {
        this._syncTempCapability()
          .then(() => this._attachTempMirror())
          .catch(this.error);
      }, 500);
    }

    // Fuentes del espejo de estado (def. 29): se valida que el nombre
    // corresponda a un device real con la capability que hace falta, igual que
    // `temp_source` (def. 9).
    const fuentes = [
      ['flap_source', 'alarm_contact', { en: 'contact', es: 'de contacto' }],
      ['discharge_temp_source', 'measure_temperature', { en: 'temperature', es: 'de temperatura' }],
      ['outdoor_temp_source', 'measure_temperature', { en: 'temperature', es: 'de temperatura' }],
    ];
    for (const [key, capability, tipo] of fuentes) {
      if (!changedKeys.includes(key)) continue;
      const nombre = String(newSettings[key] || '').trim();
      if (nombre === '') continue;
      const encontrado = await this.homey.app.stateMirror.findSourceByName(nombre, capability)
        .catch(() => undefined); // HomeyAPI caída: no validar (undefined ≠ null)
      if (encontrado === null) {
        throw new Error(this.homey.__({
          en: `No device named "${nombre}" with a ${tipo.en} sensor was found.`,
          es: `No se encontró un dispositivo "${nombre}" con sensor ${tipo.es}.`,
        }));
      }
    }

    if (changedKeys.some((key) => ['flap_source', 'flap_inverted', 'discharge_temp_source', 'outdoor_temp_source'].includes(key))) {
      this.homey.setTimeout(() => this._attachStateMirror(), 500);
    }

    if (changedKeys.some((key) => key.startsWith('allow_') || key.startsWith('auto_off')
      || key === 'swing_type' || key === 'code')) {
      // newSettings todavía no está aplicado dentro de onSettings: diferir.
      // (code afecta la visibilidad del botón "Aprender", def. 7 rev., y los
      // tiempos aprendidos de apagado automático, def. 28.)
      this.homey.setTimeout(() => this._syncAllowedFeatures().catch(this.error), 500);
    }
  }

}

module.exports = AcDevice;
