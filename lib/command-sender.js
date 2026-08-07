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

const IrCodes = require('./ir-codes');

const LEGACY_DEVICE = 'ac1'; // fijo (def. 3)

// Mapa script → webhook para el fallback ante token rechazado (def. 27).
function webhookFor(scriptName) {
  return scriptName === 'ac_command' ? 'ac_command' : scriptName;
}
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
    // Def. 27: si el token (p. ej. el default base sembrado en una casa con
    // otra auth) es rechazado, se marca acá para ir directo al webhook en los
    // siguientes comandos y no pagar un 401 por cada uno. Se reevalúa al
    // reiniciar la app o al cambiar el token (resetTokenState).
    this._tokenRejected = false;
    // Def. 7 rev. 2026-08-06: `script.ac_learn` con respuesta es nuevo y todavía
    // no está en toda la flota. Si el servidor no lo tiene, se marca acá y los
    // learns siguientes van derecho al webhook clásico (que sí existe en todas)
    // en vez de pagar un error por cada uno.
    this._learnServiceMissing = false;
  }

  /** Reinicia el estado de token rechazado (llamar al cambiar el token). */
  resetTokenState() {
    this._tokenRejected = false;
    this._learnServiceMissing = false;
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
   * Comando de auto-apagado del equipo (def. 28), en modo "lo maneja el aire":
   * fila mode-only `timer_off_XX` de la planilla, igual que el swing. `hours`
   * en horas (0 = comando de cancelar el temporizador). Sin código en la
   * planilla no se envía nada ({ok: true, skipped: true}) — a diferencia del
   * estado, acá NO hay fallback legacy (el servidor no sabe de temporizadores).
   */
  async sendTimer(config, hours) {
    const command = await this._ir.getTimerCommand(config.code, hours);
    if (!command) {
      const key = IrCodes.timerKey(hours);
      this._log(`${key}: sin código en la planilla, no se envía`);
      const missing = this._hasCode(config) ? [key] : [];
      return { ok: true, skipped: true, missing };
    }
    const result = await this._post(config, 'ac_command', {
      remote_entity: this._remoteEntity(config),
      command_code: command,
    });
    return { ...result, missing: [] };
  }

  /**
   * Learning del auto-apagado (def. 28). Según `config.learnTimerScope`, con
   * la misma idea que el alcance de temperaturas (def. 22):
   *   'single' → un solo tiempo, por el camino `simple_mode` del swing: el
   *     servidor guarda `ir_{dev}_timer_off_XX` sin cambios de su lado.
   *   'range' / 'hour' → BARRIDO: `hvac_mode` sin valor (`timer_off` o
   *     `timer_off_horas`) y sin `simple_mode`, para que el servidor despache
   *     `script.learn_{dev}_timer_off[_horas]` — un `remote.learn_command` con
   *     la lista entera, igual que el 16–30 de temperaturas. Requiere los
   *     scripts de `docs/referencia/ha-script-ac_timer_learn.yaml` y la rama
   *     `timer_off` de `ha-automation-ac_learn.yaml` en el servidor.
   */
  async sendTimerLearn(config, hours) {
    const base = { remote_entity: this._remoteEntity(config), device: LEGACY_DEVICE };
    const scope = config.learnTimerScope || 'range';
    if (scope === 'single') {
      return this._post(config, 'ac_learn', {
        ...base,
        hvac_mode: IrCodes.timerKey(hours),
        simple_mode: true,
      });
    }
    return this._post(config, 'ac_learn', {
      ...base,
      hvac_mode: scope === 'hour' ? 'timer_off_horas' : 'timer_off',
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
   * comando. Desde la def. 7 rev. (2026-08-06) 'ac_learn' hace lo mismo con
   * `script.ac_learn`, que verifica el remote y contesta al instante (el
   * aprendizaje en sí lo lanza sin esperarlo, porque bloquea minutos). Sin
   * token, o si el servidor todavía no tiene ese script, se cae al webhook
   * clásico (sin feedback del remote).
   *
   * @returns {Promise<{ok:boolean, error?:Error, remoteDown?:boolean, detail?:string}>}
   *   ok:false          → no se pudo contactar al PHM (red) → el device revierte.
   *   ok:true+remoteDown → HA recibió pero el remote no respondió → warning sin revertir.
   */
  async _post(config, webhook, payload) {
    const conToken = Boolean(config.haToken) && !this._tokenRejected;
    if (conToken && webhook === 'ac_command') {
      return this._postServiceWithResponse(config, 'ac_command', payload);
    }
    // Learning con feedback (def. 7 rev.): el script verifica el remote y
    // contesta al instante; el aprendizaje en sí lo lanza sin esperarlo.
    if (conToken && webhook === 'ac_learn' && !this._learnServiceMissing) {
      return this._postServiceWithResponse(config, 'ac_learn', payload);
    }
    return this._postWebhook(config, webhook, payload);
  }

  async _postWebhook(config, webhook, payload) {
    const url = this._webhookUrl(config, webhook);
    let lastError = null;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this._retries; attempt++) {
      try {
        this._log(`POST ${url} (intento ${attempt}/${this._retries}):`, JSON.stringify(payload));
        const res = await this._fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { lastStatus = res.status; throw new Error(`HTTP ${res.status}`); }
        return { ok: true };
      } catch (err) {
        lastError = err;
        this._error(`Fallo el envío a ${webhook} (intento ${attempt}):`, err.message || err);
        if (attempt < this._retries) await this._wait(this._backoffMs * attempt);
      }
    }
    return { ok: false, error: lastError, reason: CommandSender._classifyTransport(lastStatus) };
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
    let lastStatus = 0;
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
        // Token inválido en esta casa (p. ej. el token base sembrado por
        // defecto en un clon con otra auth): NO fallar ni revertir — caer al
        // webhook clásico (sin feedback), que sí funciona. Sin reintentos:
        // es config, no transitorio.
        if (res.status === 401 || res.status === 403) {
          this._tokenRejected = true;
          this._error(`Token rechazado (HTTP ${res.status}) en script.${scriptName}: uso el webhook clásico de acá en más.`);
          return this._postWebhook(config, webhookFor(scriptName), payload);
        }
        // El servidor todavía no tiene `script.ac_learn` (def. 7 rev.): HA
        // responde 400/404 cuando el servicio no existe. NO es una falla del
        // aprendizaje — se cae al webhook clásico, que sí está en toda la
        // flota, y se recuerda para no repetir el error en cada learn.
        if (scriptName === 'ac_learn' && (res.status === 400 || res.status === 404)) {
          this._learnServiceMissing = true;
          this._error(`script.ac_learn no existe en este servidor (HTTP ${res.status}): uso el webhook clásico de acá en más.`);
          return this._postWebhook(config, 'ac_learn', payload);
        }
        if (!res.ok) { lastStatus = res.status; throw new Error(`HTTP ${res.status}`); }
        const body = await this._readJson(res);
        const resp = (body && body.service_response) || {};
        if (resp.ok === false) {
          return { ok: true, remoteDown: true, reason: resp.reason || resp.detail || 'remote_unavailable', detail: resp.detail };
        }
        return { ok: true };
      } catch (err) {
        lastError = err;
        this._error(`Fallo el envío a script.${scriptName} (intento ${attempt}):`, err.message || err);
        if (attempt < this._retries) await this._wait(this._backoffMs * attempt);
      }
    }
    return { ok: false, error: lastError, reason: CommandSender._classifyTransport(lastStatus) };
  }

  /**
   * Clasifica una falla de transporte HTTP en un motivo legible por el device
   * (def. 26 rev. 2026-07-18: mensajes de error más específicos).
   *   status 0    → fetch lanzó (red): no se pudo contactar al PHM.
   *   404         → el servicio/webhook no existe en el PHM (mal configurado).
   *   >= 500      → el PHM recibió pero falló internamente.
   *   otro 4xx    → rechazo genérico del PHM.
   */
  static _classifyTransport(status) {
    if (status === 404) return 'service_missing';
    if (status >= 500) return 'server_error';
    if (status >= 400) return 'http_error';
    return 'no_connection';
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
   * Devuelve un `reason` clasificado (paridad con los mensajes del envío):
   *   no_token / no_connection / token_rejected / remote_not_found /
   *   reload_failed.
   */
  async reloadBroadlink(config) {
    if (!config.haToken) {
      return { ok: false, reason: 'no_token' };
    }
    const entity = this._remoteEntity(config);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.haToken}`,
    };

    // Pre-chequeo de existencia: GET al estado de la entidad — 404 = no está
    // registrada en el PHM (mismo caso que remote_not_found del envío).
    try {
      const check = await this._fetch(`${this._baseUrl(config)}/api/states/${entity}`, { headers });
      if (check.status === 404) return { ok: false, reason: 'remote_not_found' };
      if (check.status === 401 || check.status === 403) return { ok: false, reason: 'token_rejected' };
    } catch (err) {
      this._error('Sin conexión con el PHM al reconectar:', err.message || err);
      return { ok: false, reason: 'no_connection', error: err };
    }

    try {
      const res = await this._fetch(`${this._baseUrl(config)}/api/services/homeassistant/reload_config_entry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ entity_id: entity }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (err) {
      this._error('Fallo al reconectar el control:', err.message || err);
      return { ok: false, reason: 'reload_failed', error: err };
    }
  }

}

module.exports = CommandSender;
module.exports.TWO_STEP_DELAY_MS = TWO_STEP_DELAY_MS;
module.exports.LEGACY_DEVICE = LEGACY_DEVICE;
