'use strict';

const Homey = require('homey');

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

    if (this.getCapabilityValue('onoff') === null) {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    // measure_temperature solo si hay device fuente (def. 9): presencia de
    // la capability + suscripción al device fuente vía HomeyAPI.
    await this._syncTempCapability().catch(this.error);
    this._attachTempMirror();

    // Funciones permitidas del equipo (def. 21): presencia de capabilities
    // y modos visibles según settings.
    await this._syncAllowedFeatures().catch(this.error);

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
    this.registerCapabilityListener('learning_mode', (value) => this._onLearning(value));
    this.registerCapabilityListener('button.reload_codes', () => this._onReloadCodes());
    this.registerCapabilityListener('button.reconnect', () => this._onReconnect());

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

    if (!result.ok) return this._failure(result.error);
    if (result.remoteDown) return this._warnRemoteDown(result.detail); // lanza → revierte el swing
    if (result.skipped) this.log(`Swing ${key} sin código en la planilla: solo queda el estado en el tile.`);
    await this._warnMissing(result.missing);
    this._triggerFlow('swing', key);
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
      throw new Error(this.homey.__({
        en: 'Could not reconnect the control. Check its power/Wi-Fi.',
        es: 'No se pudo reconectar el control. Revisá su energía/Wi-Fi.',
      }));
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

    let result;
    if (this._learning) {
      result = await sender.sendLearn(config, state, trigger);
      this._learning = false;
      await this.setCapabilityValue('learning_mode', false).catch(this.error);
    } else {
      result = await sender.sendState(config, state, trigger);
    }

    if (!result.ok) return this._failure(result.error);
    if (result.remoteDown) return this._warnRemoteDown(result.detail);
    await this._warnMissing(result.missing);
    return result;
  }

  /**
   * Def. 26: HA recibió el comando pero el control IR (Broadlink) no
   * respondió. NO se revierte el tile (el comando llegó al servidor; el
   * estado es válido) — se avisa en el tile + Telegram, con la instrucción
   * de usar "Reconectar control". Sin throw.
   */
  async _warnRemoteDown(detail) {
    const { remoteEntity } = this._config();
    const suffix = (remoteEntity ? ` — ${remoteEntity}` : '') + (detail ? ` (${detail})` : '');

    // Banner persistente en el tile (transición null→texto para re-emitir en
    // cada envío fallido, no solo al reabrir el tile).
    await this.setWarning(null).catch(() => {});
    await this.setWarning(this.homey.__({
      en: 'The remote control is not responding. The change was NOT applied. Try "Reconnect control" (device settings) or check its power/Wi-Fi.',
      es: 'El control no responde. El cambio NO se aplicó. Probá "Reconectar control" (config. del equipo) o revisá su energía/Wi-Fi.',
    })).catch(() => {});

    // Telegram con la entidad del remote no disponible (pedido Fernán 2026-07-18).
    this.homey.app.telegram.notifyFailure(
      this.getName(),
      this.homey.__({ en: 'IR remote not responding', es: 'El control IR no responde' }) + suffix,
    ).catch(this.error);

    // Notificación en el timeline de Homey (campanita) — feedback bien visible.
    this.homey.notifications.createNotification({
      excerpt: this.homey.__({
        en: `⚠️ ${this.getName()}: the remote control is not responding. The change was not applied.`,
        es: `⚠️ ${this.getName()}: el control no responde. El cambio no se aplicó.`,
      }),
    }).catch(this.error);

    // Def. 26 (rev. 2026-07-18): el aire físico NO cambió (el control IR no
    // disparó), así que revertimos el tile — el listener LANZA y Homey vuelve
    // el valor al anterior. El "pegar la vuelta" es el feedback visible.
    throw new Error(this.homey.__({
      en: 'The remote control is not responding. The change was not applied.',
      es: 'El control no responde. El cambio no se aplicó.',
    }));
  }

  /**
   * Aviso de comandos ausentes en la planilla (pedido de Fernán 2026-07-15):
   * con code configurado y clave inexistente, el envío sale igual por el
   * camino legacy, pero el tile muestra qué comando falta. Sin faltantes,
   * se limpia el warning.
   */
  async _warnMissing(missing) {
    if (Array.isArray(missing) && missing.length > 0) {
      await this.setWarning(this.homey.__({
        en: `Command not available in the code sheet: ${missing.join(', ')}`,
        es: `Comando no disponible en la planilla: ${missing.join(', ')}`,
      })).catch(() => {});
    } else {
      await this.setWarning(null).catch(() => {});
    }
  }

  /** Def. 10: warning + Telegram + throw (el throw revierte la UI). */
  async _failure(error) {
    const detail = (error && error.message) || 'sin respuesta';
    await this.setWarning(this.homey.__({
      en: 'Could not send the command to the unit.',
      es: 'No se pudo enviar el comando al equipo.',
    })).catch(() => {});
    this.homey.app.telegram.notifyFailure(this.getName(), detail).catch(this.error);
    throw new Error(this.homey.__({
      en: 'Could not reach Pantea Home Manager. Please try again.',
      es: 'No se pudo comunicar con Pantea Home Manager. Probá de nuevo.',
    }));
  }

  /**
   * Def. 5, al prender: si la planilla tiene códigos de swing DISTINTOS para
   * on y off, se manda el del estado del tile después del encendido. Si son
   * iguales (toggle) o no existen, no se manda nada. No revierte el
   * encendido si falla: solo log.
   */
  async _swingAfterPowerOn() {
    try {
      const { code } = this._config();
      if (!code) return;
      const commands = await this.homey.app.irCodes.getSwingCommands(code);
      const available = Object.values(commands).filter((c) => c != null);
      // Hace falta más de un código distinto: con uno solo (o todos
      // repetidos = toggle) no se puede saber el estado real del equipo.
      if (new Set(available).size < 2) return;
      const key = this._swingKey();
      if (!key || !commands[key]) return;
      const result = await this.homey.app.commandSender.sendSwing(this._config(), key);
      if (!result.ok) this.error('No se pudo reenviar swing tras el encendido:', result.error?.message);
    } catch (err) {
      this.error('Error en swing post-encendido:', err);
    }
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
      }
    } catch (err) {
      this.error('No se pudo disparar la flow card:', err);
    }
  }

  /** Clave de swing vigente en el tile según el tipo configurado (def. 5 v3). */
  getSwingKey() {
    return this._swingKey();
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

  _assertModeAllowed(mode) {
    const settings = this.getSettings();
    const blocked = (mode === 'heat' && settings.allow_heat === false)
      || (mode === 'dry' && settings.allow_dry === false)
      || (mode === 'fan' && settings.allow_fan_mode === false);
    if (blocked) {
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
    if (this._phmSettingsListener) this.homey.settings.removeListener('set', this._phmSettingsListener);
  }

  async onUninit() {
    this.homey.app.tempMirror?.detach(this);
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

    if (changedKeys.some((key) => key.startsWith('allow_') || key === 'swing_type')) {
      // newSettings todavía no está aplicado dentro de onSettings: diferir.
      this.homey.setTimeout(() => this._syncAllowedFeatures().catch(this.error), 500);
    }
  }

}

module.exports = AcDevice;
