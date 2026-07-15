'use strict';

const Homey = require('homey');

class PanteaDevicesApp extends Homey.App {

  async onInit() {
    this.log('Pantea Smart Devices inicializada');
  }

}

module.exports = PanteaDevicesApp;
