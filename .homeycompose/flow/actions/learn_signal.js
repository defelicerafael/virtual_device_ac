'use strict';

const Homey = require('homey');

module.exports = {
  async onRun({ device }) {
    if (device && typeof device.setLearningMode === 'function') {
      await device.setLearningMode(true);
      return true;
    } else {
      throw new Error('Device does not support learning mode');
    }
  }
};
