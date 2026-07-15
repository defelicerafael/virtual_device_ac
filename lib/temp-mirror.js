'use strict';

/**
 * Espejo de temperatura ambiente (def. 9): el AC muestra en
 * `measure_temperature` el valor de OTRO device de Homey (el "fuente"),
 * identificado por nombre en el setting `temp_source`.
 *
 * Se suscribe vía HomeyAPI con makeCapabilityInstance (mismo patrón que
 * lights); el eco de creación acá es bienvenido: siembra el valor inicial.
 * Degrada sin romper si la HomeyAPI no está disponible (gotcha dev-mode).
 */

class TempMirror {

  /**
   * @param {object} opts
   * @param {() => Promise<any>} opts.getHomeyApi
   * @param {(...args: any[]) => void} [opts.log]
   * @param {(...args: any[]) => void} [opts.error]
   */
  constructor({ getHomeyApi, log, error } = {}) {
    if (typeof getHomeyApi !== 'function') throw new Error('TempMirror: falta getHomeyApi');
    this._getHomeyApi = getHomeyApi;
    this._log = log || (() => {});
    this._error = error || (() => {});
    /** @type {Map<string, {instance: any, sourceName: string}>} clave: id del device AC */
    this._subscriptions = new Map();
  }

  /** Busca por nombre un device con measure_temperature. null si no existe. */
  async findSourceByName(name) {
    const clean = String(name || '').trim();
    if (clean === '') return null;
    const api = await this._getHomeyApi();
    const devices = await api.devices.getDevices();
    return Object.values(devices).find(
      (device) => device.name === clean
        && Array.isArray(device.capabilities)
        && device.capabilities.includes('measure_temperature'),
    ) || null;
  }

  /**
   * Suscribe el AC al device fuente. Reemplaza la suscripción anterior.
   * @param {import('homey').Device} acDevice
   * @param {string} sourceName
   * @returns {Promise<boolean>} true si quedó suscripto
   */
  async attach(acDevice, sourceName) {
    this.detach(acDevice);
    try {
      const source = await this.findSourceByName(sourceName);
      if (!source) {
        this._log(`temp-mirror: fuente "${sourceName}" no encontrada para ${acDevice.getName()}`);
        return false;
      }
      const instance = source.makeCapabilityInstance('measure_temperature', (value) => {
        if (typeof value !== 'number') return;
        acDevice.setCapabilityValue('measure_temperature', value).catch(this._error);
      });
      this._subscriptions.set(this._key(acDevice), { instance, sourceName });

      // Valor inicial (por si el instance no emite el eco de creación).
      const current = source.capabilitiesObj?.measure_temperature?.value;
      if (typeof current === 'number') {
        acDevice.setCapabilityValue('measure_temperature', current).catch(this._error);
      }
      this._log(`temp-mirror: ${acDevice.getName()} espeja a "${sourceName}"`);
      return true;
    } catch (err) {
      this._error(`temp-mirror: no se pudo suscribir a "${sourceName}":`, err.message || err);
      return false;
    }
  }

  /** Da de baja la suscripción del AC (si la hay). */
  detach(acDevice) {
    const key = this._key(acDevice);
    const entry = this._subscriptions.get(key);
    if (!entry) return;
    try { entry.instance.destroy(); } catch (_) { /* ya muerto */ }
    this._subscriptions.delete(key);
  }

  destroyAll() {
    for (const entry of this._subscriptions.values()) {
      try { entry.instance.destroy(); } catch (_) { /* ya muerto */ }
    }
    this._subscriptions.clear();
  }

  _key(acDevice) {
    return acDevice.getData().id;
  }

}

module.exports = TempMirror;
