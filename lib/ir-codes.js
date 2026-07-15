'use strict';

/**
 * Servicio de códigos IR: consulta el webservice de la planilla (Apps Script),
 * cachea las filas por code y responde comandos por clave.
 *
 * Formato de fila del webservice (ver docs/planilla-ir.md):
 *   { code, mode, fan, temp, sleep, irCommand, ...columnas de validación }
 *
 * Indexado (misma regla que el HomeyScript PS Broadlink):
 *   - fila con mode "off", sin temp, o swing_* → clave = mode
 *   - resto → clave = `${mode}_${fan}_${temp}_${sleep}`
 *
 * Módulo Node puro (sin Homey) para poder testearlo local: recibe por
 * opciones el fetch, la URL base y los loggers.
 */

// Claves de swing (def. 5 v3): filas mode-only `swing_<clave>`. 'on'/'off'
// para equipos con swing tipo on/off; el resto para swing por posición
// ('off' es compartida).
const SWING_KEYS = ['on', 'off', 'auto', 'up', 'middle', 'down'];
const SWING_POSITIONS = ['auto', 'up', 'middle', 'down', 'off'];
const SWING_MODES = SWING_KEYS.map((k) => `swing_${k}`);

class IrCodes {

  /**
   * @param {object} opts
   * @param {() => string} opts.getBaseUrl - URL del webservice, SIN el `?code=` (se lee en cada uso: puede cambiar en settings de app)
   * @param {() => string} [opts.getBrandsUrl] - URL para marcas; default: base con `?marcas=`
   * @param {typeof fetch} [opts.fetchFn]
   * @param {(...args: any[]) => void} [opts.log]
   * @param {(...args: any[]) => void} [opts.error]
   */
  constructor({ getBaseUrl, getBrandsUrl, fetchFn, log, error } = {}) {
    if (typeof getBaseUrl !== 'function') throw new Error('IrCodes: falta getBaseUrl');
    this._getBaseUrl = getBaseUrl;
    this._getBrandsUrl = getBrandsUrl || null;
    this._fetch = fetchFn || fetch;
    this._log = log || (() => {});
    this._error = error || (() => {});
    /** @type {Map<string, {commands: Record<string,string>, rows: object[]}>} */
    this._cache = new Map();
  }

  static fullKey({ mode, fan, temp, sleep }) {
    return `${mode}_${fan}_${temp}_${sleep}`;
  }

  /** Comando completo de estado (modo+fan+temp+sleep). null si no está en la planilla. */
  async getFullCommand(code, { mode, fan, temp, sleep }) {
    return this._getByKey(code, IrCodes.fullKey({ mode, fan, temp, sleep }));
  }

  /** Comando de modo solo (para off y para el encendido en 2 pasos). */
  async getModeCommand(code, mode) {
    return this._getByKey(code, String(mode));
  }

  /** Código de swing para una clave ('on'|'off'|'auto'|'up'|'middle'|'down'). */
  async getSwingCommand(code, key) {
    return this._getByKey(code, `swing_${key}`);
  }

  /** Todos los códigos de swing: { on, off, auto, up, middle, down } (null los que no estén). */
  async getSwingCommands(code) {
    const result = {};
    for (const key of SWING_KEYS) {
      result[key] = await this._getByKey(code, `swing_${key}`);
    }
    return result;
  }

  /**
   * Autodetección "encendido en 2 pasos" (def. 13): el code tiene filas de
   * modo solo además de off/swing (ej. code 5: heat y cool sin temp).
   */
  async hasModeOnlyRows(code) {
    const entry = await this._load(code);
    if (!entry) return false;
    // Claves de modo solo: sin '_' (descarta full keys y swing_*) y distintas de off.
    return Object.keys(entry.commands).some(
      (key) => !key.includes('_') && key !== 'off',
    );
  }

  /** Autodetección "tiene fan_mode aprendido" (def. 13): filas con fan ≠ auto. */
  async hasLearnedFan(code) {
    const entry = await this._load(code);
    if (!entry) return false;
    return entry.rows.some((row) => row.fan && String(row.fan) !== 'auto');
  }

  /** Resumen para el wizard: cantidad de comandos, modos, fans, sleep, temps. */
  async getSummary(code) {
    const entry = await this._load(code);
    if (!entry || entry.rows.length === 0) return null;
    const uniq = (arr) => [...new Set(arr)];
    const modes = uniq(entry.rows.map((r) => String(r.mode)).filter((m) => m && !SWING_MODES.includes(m)));
    const fans = uniq(entry.rows.map((r) => String(r.fan)).filter((f) => f && f !== 'undefined' && f !== ''));
    const sleeps = uniq(entry.rows.map((r) => String(r.sleep)).filter((s) => s && s !== 'undefined' && s !== ''));
    const temps = entry.rows.map((r) => Number(r.temp)).filter((t) => Number.isFinite(t) && t > 0);
    return {
      commands: entry.rows.length,
      modes,
      fans,
      sleep: sleeps.includes('on'),
      hasSwing: SWING_MODES.some((m) => entry.commands[m] != null),
      tempRange: temps.length ? [Math.min(...temps), Math.max(...temps)] : null,
      twoStep: await this.hasModeOnlyRows(code),
      learnedFan: await this.hasLearnedFan(code),
    };
  }

  /**
   * Marcas/modelos a las que aplica el code (hoja "Marcas" vía `?marcas=`).
   * Degrada a [] si el Apps Script todavía no lo soporta o falla (def. de la propuesta §7).
   */
  async getBrands(code) {
    try {
      const base = this._getBrandsUrl
        ? this._getBrandsUrl()
        : this._getBaseUrl().replace(/\?code=$/, '?marcas=');
      const rows = await this._fetchJson(`${base}${encodeURIComponent(code)}`);
      if (!Array.isArray(rows)) return [];
      return rows;
    } catch (err) {
      this._log(`getBrands(${code}): sin marcas disponibles (${err.message})`);
      return [];
    }
  }

  /** Vacía el cache (de un code, o todo) y fuerza re-consulta en el próximo uso. */
  clearCache(code) {
    if (code === undefined) this._cache.clear();
    else this._cache.delete(String(code));
  }

  /** Recarga los comandos de un code desde el webservice (botón "recargar códigos"). */
  async reload(code) {
    this.clearCache(code);
    return this._load(code, { throwOnError: true });
  }

  // -------------------- interno --------------------

  async _getByKey(code, key) {
    if (code === null || code === undefined || code === '') return null;
    const entry = await this._load(code);
    if (!entry) return null;
    const command = entry.commands[key];
    return (typeof command === 'string' && command.trim() !== '') ? command : null;
  }

  async _load(code, { throwOnError = false } = {}) {
    const cacheKey = String(code);
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    try {
      const rows = await this._fetchJson(`${this._getBaseUrl()}${encodeURIComponent(code)}`);
      if (!Array.isArray(rows)) throw new Error('respuesta no es un array');
      const entry = { commands: {}, rows };
      for (const row of rows) {
        if (row == null || row.mode == null || row.irCommand == null) continue;
        const mode = String(row.mode);
        const hasTemp = !(row.temp === '' || row.temp === null || row.temp === undefined || Number(row.temp) === 0);
        const key = (mode === 'off' || !hasTemp)
          ? mode
          : IrCodes.fullKey({ mode, fan: row.fan, temp: row.temp, sleep: row.sleep });
        entry.commands[key] = row.irCommand;
      }
      this._cache.set(cacheKey, entry);
      this._log(`code ${code}: ${rows.length} filas cargadas de la planilla`);
      return entry;
    } catch (err) {
      // Sin planilla no se corta el flujo: el que llama cae al camino legacy.
      this._error(`No se pudo consultar la planilla para code ${code}:`, err.message || err);
      if (throwOnError) throw err;
      return null;
    }
  }

  async _fetchJson(url) {
    const res = await this._fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Apps Script a veces responde con Content-Type raro: leer texto y parsear a mano.
    const text = await res.text();
    return JSON.parse(text);
  }

}

module.exports = IrCodes;
module.exports.SWING_KEYS = SWING_KEYS;
module.exports.SWING_POSITIONS = SWING_POSITIONS;
