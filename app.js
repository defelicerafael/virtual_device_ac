'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const IrCodes = require('./lib/ir-codes');
const CommandSender = require('./lib/command-sender');
const TelegramNotifier = require('./lib/telegram');

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

    // La config real (tile "Envio a Telegram" de lights vía HomeyAPI) se
    // cablea en Etapa 5; hasta entonces el notifier loguea y no envía.
    this.telegram = new TelegramNotifier({
      getChannelConfig: async () => null,
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    this.log('Pantea Smart Devices inicializada');
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
