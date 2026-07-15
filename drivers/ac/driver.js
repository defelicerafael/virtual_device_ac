'use strict';

const Homey = require('homey');
const crypto = require('node:crypto');

class AcDriver extends Homey.Driver {

  async onInit() {
    this.log('AcDriver inicializado');
  }

  /**
   * Pairing PROVISORIO (Etapa 3 del plan): alta con defaults, se configura
   * por settings. El wizard custom con consulta de planilla llega en Etapa 4.
   */
  async onPairListDevices() {
    return [
      {
        name: this.homey.__({ en: 'Air Conditioner', es: 'Aire Acondicionado' }),
        data: { id: `pantea-ac-${crypto.randomUUID()}` },
        settings: {
          phm_host: 'panteasmart.local',
          phm_port: 8123,
          remote_entity: '',
          code: '',
          temp_source: '',
          auto_on: true,
          two_step_override: 'auto',
          learned_fan_override: 'auto',
        },
      },
    ];
  }

}

module.exports = AcDriver;
