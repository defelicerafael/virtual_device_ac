'use strict';

/**
 * Envío de comandos al servidor (Pantea Home Manager): arma los payloads,
 * resuelve planilla vs. legacy, ejecuta el encendido en 2 pasos y maneja
 * reintentos. Módulo Node puro; el device (Etapa 3) decide CUÁNDO llamar y
 * qué hacer ante una falla definitiva (warning + revert + Telegram).
 *
 * config por llamada (sale de los settings del device):
 *   { host, port, remoteEntity, code, twoStepOverride, learnedFanOverride,
 *     allowSleep, allowFanSpeed }
 *   - code: número de planilla u '' (sin code = 100% legacy, def. 13)
 *   - overrides: 'auto' | 'yes' | 'no' (def. 13)
 *   - allowSleep / allowFanSpeed (def. 21): si el equipo no lo permite, se
 *     envía siempre sleep 'off' / fan 'auto' (en clave de planilla, payload
 *     legacy y learning)
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
  /**
   * @returns {Promise<{ok: boolean, error?: Error, missing: string[]}>}
   *   missing: claves que el device buscó en la planilla (code configurado)
   *   y no existen — se envió el fallback legacy, pero el tile debe avisar.
   */
  async sendState(config, state, trigger) {
    const twoStep = await this._resolveTwoStep(config);
    const st = await this._effectiveState(config, state);
    const missing = [];

    if (twoStep && trigger === 'mode' && st.mode !== 'off') {
      const modePayload = await this._buildModePayload(config, st.mode, missing);
      const first = await this._post(config, 'ac_command', modePayload);
      if (!first.ok) return { ...first, missing };
      await this._wait(TWO_STEP_DELAY_MS);
    }

    const payload = await this._buildStatePayload(config, st, missing);
    const result = await this._post(config, 'ac_command', payload);
    return { ...result, missing };
  }

  /**
   * Comando de swing (def. 5 v3). `key` según el tipo de swing del equipo:
   * 'on'|'off' (tipo on/off) o 'auto'|'up'|'middle'|'down'|'off' (por
   * posición). Solo si la planilla tiene el código de esa clave; sin código
   * no se envía nada ({ok: true, skipped: true}).
   */
  async sendSwing(config, key) {
    const command = await this._ir.getSwingCommand(config.code, key);
    if (!command) {
      this._log(`swing_${key}: sin código en la planilla, no se envía`);
      const missing = this._hasCode(config) ? [`swing_${key}`] : [];
      return { ok: true, skipped: true, missing };
    }
    const result = await this._post(config, 'ac_command', {
      remote_entity: this._remoteEntity(config),
      command_code: command,
    });
    return { ...result, missing: [] };
  }

  /**
   * Learning de swing (def. 5 v3 + 7, contrato de Fernán 2026-07-15): se
   * aprende como un comando de MODO `swing_<clave>` por el camino
   * simple_mode existente — el servidor aprende `ir_{dev}_swing_<clave>`
   * sin cambios de contrato.
   */
  async sendSwingLearn(config, key) {
    return this._post(config, 'ac_learn', {
      remote_entity: this._remoteEntity(config),
      device: LEGACY_DEVICE,
      hvac_mode: `swing_${key}`,
      simple_mode: true,
    });
  }

  /**
   * Learning (defs. 7, 16 y 22). Siempre payload estilo legacy (el servidor
   * necesita los campos para saber qué aprender).
   *  - 2 pasos + trigger 'mode': solo el modo, con simple_mode (aprende el
   *    comando de encendido).
   *  - Resto: según config.learnTempScope (def. 22):
   *      'range' (default) → SIN temperatura: el script de ac_learn recorre
   *        solo el rango 16–30.
   *      'single' → CON la temperatura del tile: aprende solo esa (para
   *        corregir una temperatura mal aprendida).
   */
  async sendLearn(config, state, trigger) {
    const twoStep = await this._resolveTwoStep(config);
    const st = await this._effectiveState(config, state);
    const base = { remote_entity: this._remoteEntity(config), device: LEGACY_DEVICE };

    let payload;
    if (twoStep && trigger === 'mode' && st.mode !== 'off') {
      payload = { ...base, hvac_mode: st.mode, simple_mode: true };
    } else {
      payload = {
        ...base,
        hvac_mode: st.mode,
        fan_mode: st.fan,
        sleep: st.sleep,
      };
      if (config.learnTempScope === 'single') payload.temperature = st.temp;
    }
    return this._post(config, 'ac_learn', payload);
  }

  // -------------------- payloads --------------------

  async _buildStatePayload(config, state, missing = []) {
    const remote = { remote_entity: this._remoteEntity(config) };
    const key = (state.mode === 'off')
      ? 'off'
      : CommandSender._irKeyOf(state);

    const command = (state.mode === 'off')
      ? await this._ir.getModeCommand(config.code, 'off')
      : await this._ir.getFullCommand(config.code, {
        mode: state.mode, fan: state.fan, temp: state.temp, sleep: state.sleep,
      });

    if (command) return { ...remote, command_code: command };

    // Con code configurado y comando ausente: se avisa (warning en el tile).
    if (this._hasCode(config)) missing.push(key);

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

  async _buildModePayload(config, mode, missing = []) {
    const remote = { remote_entity: this._remoteEntity(config) };
    const command = await this._ir.getModeCommand(config.code, mode);
    if (command) return { ...remote, command_code: command };
    if (this._hasCode(config)) missing.push(String(mode));
    return { ...remote, device: LEGACY_DEVICE, hvac_mode: mode, simple_mode: true };
  }

  _hasCode({ code }) {
    return !(code === null || code === undefined || code === '');
  }

  static _irKeyOf({ mode, fan, temp, sleep }) {
    return `${mode}_${fan}_${temp}_${sleep}`;
  }

  // -------------------- resolución de flags (defs. 13 y 21) --------------------

  /**
   * Estado efectivo a enviar (def. 21): sin permiso de sleep → 'off'; sin
   * permiso de velocidad → 'auto'; con permiso, la velocidad pasa además por
   * la regla de fan aprendido (def. 2/13).
   */
  async _effectiveState(config, state) {
    const sleep = (config.allowSleep === false) ? 'off' : state.sleep;
    const fan = (config.allowFanSpeed === false)
      ? 'auto'
      : await this._resolveEffectiveFan(config, state.fan);
    return { ...state, fan, sleep };
  }

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

  _webhookUrl({ host, port }, webhook) {
    return `http://${host}:${port || 8123}/api/webhook/${webhook}`;
  }

  _baseUrl({ host, port }) {
    return `http://${host}:${port || 8123}`;
  }

  /**
   * Envío de un comando de AC. Con token configurado y webhook 'ac_command',
   * usa la REST API de servicios con return_response (def. 26): el script
   * `ac_command` devuelve si el remote realmente respondió, así la app puede
   * avisar "control sin conexión" (remoteDown) aunque HA haya recibido el
   * comando. Sin token, o para 'ac_learn', usa el webhook clásico (sin
   * feedback del remote).
   *
   * @returns {Promise<{ok:boolean, error?:Error, remoteDown?:boolean, detail?:string}>}
   *   ok:false          → no se pudo contactar al PHM (red) → el device revierte.
   *   ok:true+remoteDown → HA recibió pero el remote no respondió → warning sin revertir.
   */
  async _post(config, webhook, payload) {
    if (config.haToken && webhook === 'ac_command') {
      return this._postServiceWithResponse(config, 'ac_command', payload);
    }
    return this._postWebhook(config, webhook, payload);
  }

  async _postWebhook(config, webhook, payload) {
    const url = this._webhookUrl(config, webhook);
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

  /**
   * Llama script.<name> vía REST API con ?return_response. La respuesta de
   * HA trae { service_response: {...} }; el script Pantea devuelve
   * { ok, reason, detail }. Reintenta solo ante falla de transporte, no
   * cuando HA responde que el remote está caído (no es transitorio).
   */
  async _postServiceWithResponse(config, scriptName, payload) {
    const url = `${this._baseUrl(config)}/api/services/script/${scriptName}?return_response`;
    let lastError = null;
    for (let attempt = 1; attempt <= this._retries; attempt++) {
      try {
        this._log(`POST ${url} (intento ${attempt}/${this._retries}):`, JSON.stringify(payload));
        const res = await this._fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.haToken}`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await this._readJson(res);
        const resp = (body && body.service_response) || {};
        if (resp.ok === false) {
          return { ok: true, remoteDown: true, detail: resp.reason || resp.detail || 'remote sin respuesta' };
        }
        return { ok: true };
      } catch (err) {
        lastError = err;
        this._error(`Fallo el envío a script.${scriptName} (intento ${attempt}):`, err.message || err);
        if (attempt < this._retries) await this._wait(this._backoffMs * attempt);
      }
    }
    return { ok: false, error: lastError };
  }

  async _readJson(res) {
    try {
      return await res.json();
    } catch (_) {
      return {};
    }
  }

  /**
   * Reconectar control (def. 26): recarga el config entry de Broadlink dueño
   * de este remote (homeassistant.reload_config_entry). Requiere token.
   */
  async reloadBroadlink(config) {
    if (!config.haToken) {
      return { ok: false, error: new Error('no-token') };
    }
    const url = `${this._baseUrl(config)}/api/services/homeassistant/reload_config_entry`;
    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.haToken}`,
        },
        body: JSON.stringify({ entity_id: this._remoteEntity(config) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (err) {
      this._error('Fallo al reconectar el control:', err.message || err);
      return { ok: false, error: err };
    }
  }

}

module.exports = CommandSender;
module.exports.TWO_STEP_DELAY_MS = TWO_STEP_DELAY_MS;
module.exports.LEGACY_DEVICE = LEGACY_DEVICE;
