'use strict';

/**
 * Aviso a Telegram ante fallas de envío (def. 10). La configuración (token
 * del bot y chat IDs) vive en el tile "Envio a Telegram" de
 * com.panteasmart.lights; acá se recibe un `getChannelConfig` inyectado que
 * la resuelve (en la app real: vía HomeyAPI, Etapa 5).
 *
 * Se usa el chat de SOPORTE si está configurado; si no, el del cliente.
 * Nunca lanza: una falla avisando no puede romper el flujo del comando.
 */

class TelegramNotifier {

  /**
   * @param {object} opts
   * @param {() => Promise<{token?: string, chatId?: string, supportChatId?: string}|null>} opts.getChannelConfig
   * @param {typeof fetch} [opts.fetchFn]
   * @param {(...args: any[]) => void} [opts.log]
   * @param {(...args: any[]) => void} [opts.error]
   */
  constructor({ getChannelConfig, fetchFn, log, error } = {}) {
    if (typeof getChannelConfig !== 'function') throw new Error('TelegramNotifier: falta getChannelConfig');
    this._getChannelConfig = getChannelConfig;
    this._fetch = fetchFn || fetch;
    this._log = log || (() => {});
    this._error = error || (() => {});
  }

  /**
   * @param {string} deviceName
   * @param {string} detail - descripción corta de la falla
   * @returns {Promise<boolean>} true si el mensaje salió
   */
  async notifyFailure(deviceName, detail) {
    try {
      const config = await this._getChannelConfig();
      const token = config?.token?.trim();
      const chatId = (config?.supportChatId || config?.chatId || '').trim();
      if (!token || !chatId) {
        this._log('Telegram sin configurar (tile "Envio a Telegram" de lights): no se avisa.');
        return false;
      }

      const text = `⚠️ ${deviceName}: no se pudo enviar el comando al equipo.\n${detail}`;
      const res = await this._fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._log(`Aviso Telegram enviado por falla en ${deviceName}`);
      return true;
    } catch (err) {
      this._error('No se pudo avisar por Telegram:', err.message || err);
      return false;
    }
  }

}

module.exports = TelegramNotifier;
