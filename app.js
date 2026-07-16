'use strict';

// ============ DIAGNÓSTICO TEMPORAL (quitar tras resolver el crash en modo
// instalado): reporta errores fatales a un listener en la Pi de San Fran.
function reportDiag(tag, err) {
  try {
    const body = `[${tag}] ${(err && (err.stack || err.message)) || String(err)}`;
    const req = require('http').request({
      host: '192.168.88.101', port: 9999, method: 'POST', path: '/',
      headers: { 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.end(body);
  } catch (_) { /* nunca romper por el diagnóstico */ }
}
process.on('uncaughtException', (err) => reportDiag('uncaughtException', err));
process.on('unhandledRejection', (err) => reportDiag('unhandledRejection', err));
reportDiag('boot', 'app.js evaluándose');
// ============ FIN DIAGNÓSTICO TEMPORAL

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const IrCodes = require('./lib/ir-codes');
const CommandSender = require('./lib/command-sender');
const TelegramNotifier = require('./lib/telegram');
const TempMirror = require('./lib/temp-mirror');

// URL del webservice de la planilla (def. 15): configurable en settings de
// app, con la URL histórica de PS Broadlink.js como default.
const DEFAULT_WEBSERVICE_URL = 'https://script.google.com/macros/s/AKfycbwdO-s-kH9uKtYq8UG9p03kVUjKLVflvxUdaprqTP4hPZh0CsguVQgnC3wZaq5kxq5Q/exec?code=';

class PanteaDevicesApp extends Homey.App {

  async onInit() {
    if (!this.homey.settings.get('webservice_url')) {
      this.homey.settings.set('webservice_url', DEFAULT_WEBSERVICE_URL);
    }

    this.irCodes = new IrCodes({
      getBaseUrl: () => this.homey.settings.get('webservice_url') || DEFAULT_WEBSERVICE_URL,
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    this.commandSender = new CommandSender({
      irCodes: this.irCodes,
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    // Config del canal: el tile "Envio a Telegram" de com.panteasmart.lights
    // es la fuente canónica (def. 10); se leen sus settings vía HomeyAPI.
    this.telegram = new TelegramNotifier({
      getChannelConfig: () => this._telegramChannelConfig(),
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    this.tempMirror = new TempMirror({
      getHomeyApi: () => this.getHomeyApi(),
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    this.log('Pantea Smart Devices inicializada');
    reportDiag('onInit', 'OK - app inicializada');
  }

  async onUninit() {
    this.tempMirror?.destroyAll();
  }

  async _telegramChannelConfig() {
    try {
      const api = await this.getHomeyApi();
      const devices = await api.devices.getDevices();
      const tile = Object.values(devices).find(
        (device) => String(device.driverId || '').includes('virtual_telegram'),
      );
      if (!tile) return null;
      const settings = tile.settings || {};
      return {
        token: settings.telegram_token,
        chatId: settings.telegram_chat_id,
        supportChatId: settings.telegram_support_chat_id,
      };
    } catch (err) {
      this.error('No se pudo leer la config de Telegram del tile de lights:', err.message || err);
      return null;
    }
  }

  /**
   * HomeyAPI compartida (lazy). La usan el wizard (drop-down de sensores de
   * temperatura), el espejo de temperatura y la config de Telegram (Etapa 5).
   * Ojo gotcha conocido: en dev-mode el DNS "homeylocal" puede romper
   * getDevices — por eso los consumidores degradan ante error.
   */
  async getHomeyApi() {
    if (!this._homeyApiPromise) {
      this._homeyApiPromise = HomeyAPI.createAppAPI({ homey: this.homey });
      this._homeyApiPromise.catch((err) => {
        this.error('HomeyAPI no disponible:', err.message || err);
        this._homeyApiPromise = null;
      });
    }
    return this._homeyApiPromise;
  }

}

module.exports = PanteaDevicesApp;
