'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

module.exports = class PanteaVirtualAC extends Homey.Device {

  async onInit() {
    this.log('Pantea Virtual AC inicializado:', this.getName());

    // Estado interno para aprendizaje
    this.learningMode = false;


    // Capabilities normales
    const caps = [
      'onoff',
      'target_temperature',
      "measure_temperature",
      'thermostat_mode',
    ];
    for (const cap of caps) {
      this.registerCapabilityListener(cap, async (value) => {
        await this.sendCommand(cap, value);
        return Promise.resolve();
      });
    }

    // Listener para el botón de aprendizaje (sin estado)
    this.registerCapabilityListener('learning_mode', async value => {
      this.log('Learning mode button pressed:', value);
      if (value) {
        this.learningMode = true;
        await this.sendCommand('learn', null);
        await this.setCapabilityValue('learning_mode', false); // Reseteamos el botón
      }
      return Promise.resolve();
    });


    this.registerCapabilityListener('sleep_on_off', async value => {
      this.log('sleep_on_off button pressed:', value);
      await this.sendCommand('sleep_on_off', value);
      return Promise.resolve();
    });

    this.registerCapabilityListener('swing_on_off', async value => {
      this.log('swing_on_off button pressed:', value);
      await this.sendCommand('swing_on_off', value);
      return Promise.resolve();
    });
  }

  async sendCommand(capability, value) {
    
    
    const ip = this.getSetting('ha_ip');
    const remoteEntity = this.getSetting('remote_entity_name');
    const autoOn = this.getSetting('auto_on_temp_change');

    if (!ip || !remoteEntity) {
      this.log('Faltan settings. Abortando envío.');
      return;
    }

    const device = remoteEntity; // ← dinámico, e.g. "ac1"
    this.log(`Comando para: ${device}`);

    const sleep = this.getCapabilityValue('sleep_on_off') ? 'on' : 'off';
    const swing = this.getCapabilityValue('swing_on_off') ? 'on' : 'off';
    const fan_mode = 'auto';
    const temperature = this.getCapabilityValue('target_temperature');
    const hvac_mode = this.getCapabilityValue('thermostat_mode') || 'off';

    // Auto-on si corresponde
    if (capability === 'target_temperature' && autoOn && hvac_mode === 'off') {
      await this.setCapabilityValue('thermostat_mode', 'cool');
    }

    const payload = {
      remote_entity: `remote.${remoteEntity}`,
      device,
      hvac_mode,
      fan_mode,
      sleep,
      swing,
      temperature
    };

    // Webhook URL
    let url = `http://${ip}:8123/api/webhook/`;
    if (this.learningMode) {
      url += 'ac_learn';
      this.learningMode = false;
    } else {
      if (capability !== 'thermostat_mode' && hvac_mode === 'off') {
        this.log(`${this.getName()} en off, no se envía comando.`);
        return;
      }
      url += 'ac_command';
    }

    this.log('Enviando a Home Assistant:', url);
    this.log(JSON.stringify(payload));

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`Error ${res.status}`);
      this.log('Comando enviado correctamente.');
    } catch (err) {
      this.error('Error al enviar comando:', err);
    }
  }

  async setLearningMode(enable) {
    this.log(`Modo aprendizaje (interno): ${enable}`);
    this.learningMode = enable;
    if (enable) {
      await this.sendCommand('learn', null);
    }
  }
};
