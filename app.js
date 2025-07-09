'use strict';

const Homey = require('homey');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');

    this.appSettings = await this.homey.settings.get("settings") || {};
    const ip = await this.homey.settings.get('ha_ip');
    const entity = await this.homey.settings.get('remote_entity_name');
    const auto = await this.homey.settings.get('auto_on_temp_change');

    this.log('📦 Ajustes del dispositivo:');
    this.log('IP:', ip);
    this.log('Entity:', entity);
    this.log('Auto ON:', auto);
    this.log('🛠️ Settings del dispositivo:', this.appSettings);
  }

};
