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

    // measure_temperature solo si hay device fuente (def. 9).
    // El espejo real del valor llega en Etapa 5; acá se maneja la presencia.
    await this._syncTempCapability().catch(this.error);

    this.registerCapabilityListener('onoff', (value) => this._onOnOff(value));
    this.registerCapabilityListener('thermostat_mode', (value) => this._onMode(value));
    this.registerCapabilityListener('target_temperature', (value) => this._onTemperature(value));
    this.registerCapabilityListener('fan_mode', (value) => this._onFanOrSleep('fan', value));
    this.registerCapabilityListener('sleep_on_off', (value) => this._onFanOrSleep('sleep', value));
    this.registerCapabilityListener('swing_on_off', (value) => this._onSwing(value));
    this.registerCapabilityListener('learning_mode', (value) => this._onLearning(value));
    this.registerCapabilityListener('button.reload_codes', () => this._onReloadCodes());
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
    return true;
  }

  /** Swing (def. 5): comando propio, solo si la planilla tiene el código. */
  async _onSwing(value) {
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'off';
    if (currentMode === 'off') {
      this.log('Apagado: swing queda en el tile, no se envía.');
      return true;
    }
    const result = await this.homey.app.commandSender.sendSwing(this._config(), value === true);
    if (!result.ok) return this._failure(result.error);
    if (result.skipped) this.log('Swing sin código en la planilla: solo queda el estado en el tile.');
    await this.setWarning(null).catch(() => {});
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
    await this.setWarning(null).catch(() => {});
    return result;
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
      const swing = await this.homey.app.irCodes.getSwingCommands(code);
      if (!swing.on || !swing.off || swing.on === swing.off) return;
      const wantOn = this.getCapabilityValue('swing_on_off') === true;
      const result = await this.homey.app.commandSender.sendSwing(this._config(), wantOn);
      if (!result.ok) this.error('No se pudo reenviar swing tras el encendido:', result.error?.message);
    } catch (err) {
      this.error('Error en swing post-encendido:', err);
    }
  }

  // -------------------- estado y config --------------------

  _config() {
    const settings = this.getSettings();
    return {
      host: (settings.phm_host || '').trim(),
      port: Number(settings.phm_port) || 8123,
      remoteEntity: (settings.remote_entity || '').trim(),
      code: String(settings.code ?? '').trim(),
      twoStepOverride: settings.two_step_override || 'auto',
      learnedFanOverride: settings.learned_fan_override || 'auto',
    };
  }

  _state(overrides = {}) {
    return {
      mode: overrides.mode ?? this.getCapabilityValue('thermostat_mode') ?? 'off',
      fan: overrides.fan ?? this.getCapabilityValue('fan_mode') ?? 'auto',
      temp: overrides.temp ?? this.getCapabilityValue('target_temperature') ?? 24,
      sleep: overrides.sleep ?? (this.getCapabilityValue('sleep_on_off') === true ? 'on' : 'off'),
    };
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

  // -------------------- settings --------------------

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

    if (changedKeys.includes('temp_source')) {
      // La validación contra devices reales y el espejo llegan en Etapa 5.
      this.homey.setTimeout(() => this._syncTempCapability().catch(this.error), 500);
    }
  }

}

module.exports = AcDevice;
