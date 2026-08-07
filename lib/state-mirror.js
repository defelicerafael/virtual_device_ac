'use strict';

/**
 * Espejo de estado real del equipo (def. 29): un sensor de CONTACTO montado en
 * la aleta del split dice si el aire está funcionando, y de ahí se refleja el
 * estado en el tile SIN mandar ninguna señal IR.
 *
 * Por qué existe: hasta acá la app es unidireccional (def. 9 espeja solo la
 * temperatura ambiente). Si alguien prende el aire con el control físico, el
 * tile queda mintiendo. La aleta es la única señal física disponible hoy.
 *
 * Escalera de inferencia (de más fuerte a más débil):
 *   1. Aleta abierta/cerrada → PRENDIDO/APAGADO. Decisivo y sin temperatura.
 *   2. Temperatura de DESCARGA (sensor en la aleta) vs. la del cuarto →
 *      frío/calor. Decisivo: es el aire que el equipo está tirando. Todavía no
 *      hay sensores así en la flota (el combo contacto+temperatura no existe
 *      en el parque instalado) — la lógica queda lista para cuando haya.
 *   3. Cómo se MUEVE la temperatura del cuarto tras prender → frío/calor.
 *      Indicio.
 *   4. Temperatura de AFUERA → frío/calor. Indicio. Es lo que hay hoy con
 *      sensores de contacto solos.
 *   5. El último modo usado desde el tile. Último recurso.
 *
 * ⚠️ Regla de seguridad: los INDICIOS (3, 4 y 5) solo infieren cuando el tile
 * estaba apagado — o sea, cuando el encendido vino del control físico y la app
 * no tiene ni idea del modo. Nunca pisan un modo que la app ya conoce: si el
 * usuario prende en `cool` desde Homey en pleno invierno, la temperatura de
 * afuera diría "calor" y le cambiaría el tile de abajo. Solo la evidencia
 * DECISIVA (2) puede corregir un modo ya puesto.
 *
 * Módulo Node puro salvo la parte de suscripción: `decide()` no toca Homey y
 * se testea sola.
 */

// Márgenes de la escalera. Elegidos para no clasificar de más: ante la duda,
// el resultado es "no sé" y el tile no se toca.
const DISCHARGE_MARGIN_C = 3; // descarga vs. cuarto
const TREND_MARGIN_C = 0.5; // cuánto se tiene que mover el cuarto
const OUTDOOR_BAND_C = 3; // banda muerta alrededor del corte de afuera

/**
 * Resuelve el modo (`heat`/`cool`) a partir de la evidencia disponible.
 *
 * @param {object} input
 * @param {number|null} [input.dischargeTemp] temperatura del aire que sale
 * @param {number|null} [input.roomTemp] temperatura actual del cuarto
 * @param {number|null} [input.roomTempAtStart] la del cuarto al abrirse la aleta
 * @param {number|null} [input.outdoorTemp] temperatura de afuera
 * @param {number} [input.outdoorCutoff] corte frío/calor de afuera (°C)
 * @param {string|null} [input.lastMode] último modo usado desde el tile
 * @returns {{mode: string|null, reason: string, decisive: boolean}}
 *   mode null = no alcanza la evidencia, no tocar el modo del tile.
 */
function decide({
  dischargeTemp = null,
  roomTemp = null,
  roomTempAtStart = null,
  outdoorTemp = null,
  outdoorCutoff = 19,
  lastMode = null,
} = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const discharge = num(dischargeTemp);
  const room = num(roomTemp);
  const start = num(roomTempAtStart);
  const outdoor = num(outdoorTemp);

  // 2. Descarga vs. cuarto: lo que el equipo está tirando AHORA.
  if (discharge != null && room != null) {
    if (discharge >= room + DISCHARGE_MARGIN_C) return { mode: 'heat', reason: 'discharge', decisive: true };
    if (discharge <= room - DISCHARGE_MARGIN_C) return { mode: 'cool', reason: 'discharge', decisive: true };
    // Diferencia chica: el equipo arrancó recién, está en ventilación o el
    // sensor no está en el chorro. No alcanza para afirmar nada.
  }

  // 3. Hacia dónde se movió el cuarto desde que arrancó.
  if (room != null && start != null) {
    const delta = room - start;
    if (delta >= TREND_MARGIN_C) return { mode: 'heat', reason: 'room_trend', decisive: false };
    if (delta <= -TREND_MARGIN_C) return { mode: 'cool', reason: 'room_trend', decisive: false };
  }

  // 4. Estación, vía temperatura de afuera.
  if (outdoor != null) {
    if (outdoor >= outdoorCutoff + OUTDOOR_BAND_C) return { mode: 'cool', reason: 'outdoor', decisive: false };
    if (outdoor <= outdoorCutoff - OUTDOOR_BAND_C) return { mode: 'heat', reason: 'outdoor', decisive: false };
  }

  // 5. Lo último que se usó desde el tile.
  if (lastMode && lastMode !== 'off') return { mode: lastMode, reason: 'last_mode', decisive: false };

  return { mode: null, reason: 'undetermined', decisive: false };
}

class StateMirror {

  /**
   * @param {object} opts
   * @param {() => Promise<any>} opts.getHomeyApi
   * @param {(...args: any[]) => void} [opts.log]
   * @param {(...args: any[]) => void} [opts.error]
   */
  constructor({ getHomeyApi, log, error } = {}) {
    if (typeof getHomeyApi !== 'function') throw new Error('StateMirror: falta getHomeyApi');
    this._getHomeyApi = getHomeyApi;
    this._log = log || (() => {});
    this._error = error || (() => {});
    /** @type {Map<string, {instance: any, sources: object}>} clave: id del device AC */
    this._subscriptions = new Map();
  }

  /** Busca por nombre un device que tenga una capability dada. null si no existe. */
  async findSourceByName(name, capability) {
    const clean = String(name || '').trim();
    if (clean === '') return null;
    const api = await this._getHomeyApi();
    const devices = await api.devices.getDevices();
    return Object.values(devices).find(
      (device) => device.name === clean
        && Array.isArray(device.capabilities)
        && device.capabilities.includes(capability),
    ) || null;
  }

  /**
   * Suscribe el AC al sensor de contacto de la aleta. Reemplaza la suscripción
   * anterior. Los sensores de temperatura NO se suscriben: se leen al momento
   * de decidir (`readTemps`), que es cuando importan.
   *
   * @param {import('homey').Device} acDevice
   * @param {{contact: string, inverted: boolean, discharge: string, outdoor: string}} sources
   * @returns {Promise<boolean>} true si quedó suscripto al contacto
   */
  async attach(acDevice, sources) {
    this.detach(acDevice);
    const clean = {
      contact: String(sources.contact || '').trim(),
      inverted: sources.inverted === true,
      discharge: String(sources.discharge || '').trim(),
      outdoor: String(sources.outdoor || '').trim(),
    };
    if (clean.contact === '') return false;

    try {
      const source = await this.findSourceByName(clean.contact, 'alarm_contact');
      if (!source) {
        this._log(`state-mirror: sensor de aleta "${clean.contact}" no encontrado para ${acDevice.getName()}`);
        return false;
      }
      const instance = source.makeCapabilityInstance('alarm_contact', (value) => {
        if (typeof value !== 'boolean') return;
        // `alarm_contact` true = contacto ABIERTO. Con el imán invertido en el
        // montaje, la aleta abierta da false: lo corrige el setting.
        acDevice.onFlapChanged(clean.inverted ? !value : value);
      });
      this._subscriptions.set(this._key(acDevice), { instance, sources: clean });

      const current = source.capabilitiesObj?.alarm_contact?.value;
      if (typeof current === 'boolean') {
        acDevice.onFlapChanged(clean.inverted ? !current : current);
      }
      this._log(`state-mirror: ${acDevice.getName()} mira la aleta "${clean.contact}"`);
      return true;
    } catch (err) {
      this._error(`state-mirror: no se pudo suscribir a "${clean.contact}":`, err.message || err);
      return false;
    }
  }

  /**
   * Lee las temperaturas que necesita la escalera, en el momento de decidir.
   * Cada una degrada a null por separado: que falte una no invalida al resto.
   * @returns {Promise<{discharge: number|null, outdoor: number|null}>}
   */
  async readTemps(acDevice) {
    const entry = this._subscriptions.get(this._key(acDevice));
    const sources = (entry && entry.sources) || {};
    const read = async (name) => {
      if (!name) return null;
      try {
        const device = await this.findSourceByName(name, 'measure_temperature');
        const value = device?.capabilitiesObj?.measure_temperature?.value;
        return typeof value === 'number' ? value : null;
      } catch (err) {
        this._error(`state-mirror: no se pudo leer "${name}":`, err.message || err);
        return null;
      }
    };
    return {
      discharge: await read(sources.discharge),
      outdoor: await read(sources.outdoor),
    };
  }

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

module.exports = StateMirror;
module.exports.decide = decide;
module.exports.DISCHARGE_MARGIN_C = DISCHARGE_MARGIN_C;
module.exports.TREND_MARGIN_C = TREND_MARGIN_C;
module.exports.OUTDOOR_BAND_C = OUTDOOR_BAND_C;
