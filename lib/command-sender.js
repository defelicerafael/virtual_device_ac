'use strict';

/**
 * Envío de comandos al servidor (Pantea Home Manager): arma los payloads,
 * resuelve planilla vs. legacy, ejecuta el encendido en 2 pasos y maneja
 * reintentos. Módulo Node puro; el device (Etapa 3) decide CUÁNDO llamar y
 * qué hacer ante una falla definitiva (warning + revert + Telegram).
 *
 * config por llamada (sale de los settings del device):
 *   { host, port, remoteEntity, code, twoStepOverride, learnedFanOverride }
 *   - code: número de planilla u '' (sin code = 100% legacy, def. 13)
 *   - overrides: 'auto' | 'yes' | 'no' (def. 13)
 *
 * state (valores del tile ya resueltos por el device):
 *   { mode, fan, temp, sleep }  — sleep como 'on'/'off'
 *
 * trigger: qué capability disparó el envío ('mode' | 'temperature' | 'fan'
 *   | 'sleep' | 'onoff') — define el encendido en 2 pasos y el learning.
 */

const LEGACY_DEVICE = 'ac1'; // fijo (def. 3)
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const TWO_STEP_DELAY_MS = 2000; // fijo (propuesta §4)

class CommandSender {

  /**
   * @param {object} opts
   * @param {import('./ir-codes')} opts.irCodes
   * @param {typeof fetch} [opts.fetchFn]
   * @param {(ms: number) => Promise<void>} [opts.waitFn]
   * @param {(...args: any[]) => void} [opts.log]
   * @param {(...args: any[]) => void} [opts.error]
   * @param {number} [opts.retries]
   * @param {number} [opts.backoffMs]
   */
  constructor({ irCodes, fetchFn, waitFn, log, error, retries, backoffMs } = {}) {
    if (!irCodes) throw new Error('CommandSender: falta irCodes');
    this._ir = irCodes;
    this._fetch = fetchFn || fetch;
    this._wait = waitFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._log = log || (() => {});
    this._error = error || (() => {});
    this._retries = retries ?? DEFAULT_RETRIES;
    this._backoffMs = backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /**
   * Comando de estado (modo/temp/fan/sleep/apagado). Aplica: fan efectivo,
   * planilla→legacy y encendido en 2 pasos cuando trigger === 'mode'.
   * @returns {Promise<{ok: boolean, error?: Error}>}
   */
  async sendState(config, state, trigger) {
    const twoStep = await this._resolveTwoStep(config);
    const effFan = await this._resolveEffectiveFan(config, state.fan);
    const st = { ...state, fan: effFan };

    if (twoStep && trigger === 'mode' && st.mode !== 'off') {
      const modePayload = await this._buildModePayload(config, st.mode);
      const first = await this._post(config, 'ac_command', modePayload);
      if (!first.ok) return first;
      await this._wait(TWO_STEP_DELAY_MS);
    }

    const payload = await this._buildStatePayload(config, st);
    return this._post(config, 'ac_command', payload);
  }

  /**
   * Comando de swing (def. 5): solo si la planilla tiene el código para ese
   * estado. Sin código: no se envía nada ({ok: true, skipped: true}).
   */
  async sendSwing(config, on) {
    const swing = await this._ir.getSwingCommands(config.code);
    const command = on ? swing.on : swing.off;
    if (!command) {
      this._log(`swing_${on ? 'on' : 'off'}: sin código en la planilla, no se envía`);
      return { ok: true, skipped: true };
    }
    return this._post(config, 'ac_command', {
      remote_entity: this._remoteEntity(config),
      command_code: command,
    });
  }

  /**
   * Learning (defs. 7 y 16). Siempre payload estilo legacy (el servidor
   * necesita los campos para saber qué aprender) y SIN temperatura: el
   * script de ac_learn recorre solo el rango 16–30.
   *  - 2 pasos + trigger 'mode': solo el modo, con simple_mode (aprende el
   *    comando de encendido).
   */
  async sendLearn(config, state, trigger) {
    const twoStep = await this._resolveTwoStep(config);
    const base = { remote_entity: this._remoteEntity(config), device: LEGACY_DEVICE };

    let payload;
    if (twoStep && trigger === 'mode' && state.mode !== 'off') {
      payload = { ...base, hvac_mode: state.mode, simple_mode: true };
    } else {
      payload = {
        ...base,
        hvac_mode: state.mode,
        fan_mode: state.fan,
        sleep: state.sleep,
      };
    }
    return this._post(config, 'ac_learn', payload);
  }

  // -------------------- payloads --------------------

  async _buildStatePayload(config, state) {
    const remote = { remote_entity: this._remoteEntity(config) };

    const command = (state.mode === 'off')
      ? await this._ir.getModeCommand(config.code, 'off')
      : await this._ir.getFullCommand(config.code, {
        mode: state.mode, fan: state.fan, temp: state.temp, sleep: state.sleep,
      });

    if (command) return { ...remote, command_code: command };

    // Fallback legacy (def. 8): el servidor resuelve con sus códigos aprendidos.
    return {
      ...remote,
      device: LEGACY_DEVICE,
      hvac_mode: state.mode,
      fan_mode: state.fan,
      sleep: state.sleep,
      temperature: state.temp,
    };
  }

  async _buildModePayload(config, mode) {
    const remote = { remote_entity: this._remoteEntity(config) };
    const command = await this._ir.getModeCommand(config.code, mode);
    if (command) return { ...remote, command_code: command };
    return { ...remote, device: LEGACY_DEVICE, hvac_mode: mode, simple_mode: true };
  }

  // -------------------- resolución de flags (def. 13) --------------------

  async _resolveTwoStep({ code, twoStepOverride }) {
    if (twoStepOverride === 'yes') return true;
    if (twoStepOverride === 'no') return false;
    if (code === null || code === undefined || code === '') return false; // sin code, 'auto' = no
    return this._ir.hasModeOnlyRows(code);
  }

  async _resolveEffectiveFan({ code, learnedFanOverride }, fan) {
    let learned;
    if (learnedFanOverride === 'yes') learned = true;
    else if (learnedFanOverride === 'no') learned = false;
    else if (code === null || code === undefined || code === '') learned = true; // sin code, 'auto' = enviar lo elegido (el servidor resuelve)
    else learned = await this._ir.hasLearnedFan(code);
    return learned ? fan : 'auto';
  }

  // -------------------- transporte --------------------

  _remoteEntity({ remoteEntity }) {
    const name = String(remoteEntity || '').trim();
    return name.startsWith('remote.') ? name : `remote.${name}`;
  }

  _url({ host, port }, webhook) {
    return `http://${host}:${port || 8123}/api/webhook/${webhook}`;
  }

  async _post(config, webhook, payload) {
    const url = this._url(config, webhook);
    let lastError = null;

    for (let attempt = 1; attempt <= this._retries; attempt++) {
      try {
        this._log(`POST ${url} (intento ${attempt}/${this._retries}):`, JSON.stringify(payload));
        const res = await this._fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ok: true };
      } catch (err) {
        lastError = err;
        this._error(`Fallo el envío a ${webhook} (intento ${attempt}):`, err.message || err);
        if (attempt < this._retries) await this._wait(this._backoffMs * attempt);
      }
    }
    return { ok: false, error: lastError };
  }

}

module.exports = CommandSender;
module.exports.TWO_STEP_DELAY_MS = TWO_STEP_DELAY_MS;
module.exports.LEGACY_DEVICE = LEGACY_DEVICE;
