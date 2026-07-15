'use strict';

const Homey = require('homey');
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

}

module.exports = PanteaDevicesApp;
