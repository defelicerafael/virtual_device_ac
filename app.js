'use strict';

const Homey = require('homey');

module.exports = class MyApp extends Homey.App {
  async onInit() {
    try {
      console.log('MyApp has been initialized');

    } catch (error) {
      this.error("🚨 Error fatal en `onInit()`:", error);
    }
  }
};
