'use strict';

const Homey = require('homey');

module.exports = class PanteaVirtualAC extends Homey.Device {

  async onInit() {
    this.log('Pantea Virtual AC inicializado:', this.getName());

    // --- INICIO DE LÍNEAS DE DEPURACIÓN DE IDs ---
    

    // Estado interno para aprendizaje
    this.learningMode = false;
    this.lastThermostatMode = this.getStoreValue('last_mode') || 'cool'; // 'cool' por defecto
    


    // Capabilities normales
    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        const lastMode = this.lastThermostatMode || await this.getStoreValue('last_mode') || 'cool';
        await this.setCapabilityValue('thermostat_mode', lastMode);
        this.log('lastMode', lastMode, value);
      } else {
        await this.setCapabilityValue('thermostat_mode', 'off');
      }
      return Promise.resolve();
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      await this.sendCommand('target_temperature', value);
      return Promise.resolve();
    });

    this.registerCapabilityListener('measure_temperature', async (value) => {
      await this.sendCommand('measure_temperature', value);
      return Promise.resolve();
    });

  this.registerCapabilityListener('thermostat_mode', async (value) => {
      if (value !== 'off') {
        this.lastThermostatMode = value;
        await this.setStoreValue('last_mode', value);
        await this.setCapabilityValue('onoff', true);   // 🔥 Prendido
      } else {
        await this.setCapabilityValue('onoff', false);  // ❄️ Apagado
      }
      await this.sendCommand('thermostat_mode', value);
      return Promise.resolve();
    });


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

    /*this.registerCapabilityListener('fan_mode', async (value) => {
      this.log('fan_mode cambiado a:', value);
      await this.sendCommand('fan_mode', value);
      return Promise.resolve();
    });*/

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

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    try {
      this.log('⚙️ Cambios en settings:', changedKeys);
      for (const key of changedKeys) {
        this.log(`🔧 ${key}:`, newSettings[key]);
      }
    } catch (error) {
      this.error('❌ Error en onSettings:', error);
    }
  }

  getCurrentState(overrides = {}) {
    return {
      remote_entity: `remote.${this.getSetting('remote_entity_name')}`,
      device: this.getSetting('codigo_ac'),
      hvac_mode: overrides.hvac_mode ?? this.getCapabilityValue('thermostat_mode') ?? 'off',
      sleep: overrides.sleep ?? (this.getCapabilityValue('sleep_on_off') ? 'on' : 'off'),
      swing: overrides.swing ?? (this.getCapabilityValue('swing_on_off') ? 'on' : 'off'),
      temperature: overrides.temperature ?? this.getCapabilityValue('target_temperature'),
      onoff: overrides.onoff ?? this.getCapabilityValue('onoff'),
      //fan_mode: overrides.fan_mode ?? this.getCapabilityValue('fan_mode') ?? 'auto',
      
    };
  }

  async sendCommand(capability, value) {
    const ip = this.getSetting('ha_ip');
    const puerto = this.getSetting('ha_port') || 8123;
    const autoOn = this.getSetting('auto_on_temp_change');
    const learning = this.learningMode;

    if (!ip || !this.getSetting('remote_entity_name')) {
      this.log('Faltan settings. Abortando envío.');
      return;
    }

  // Armamos overrides según qué capability se está cambiando
    const overrides = {};

    if (capability === 'target_temperature') overrides.temperature = value;
    if (capability === 'thermostat_mode') overrides.hvac_mode = value;
    if (capability === 'swing_on_off') overrides.swing = value ? 'on' : 'off';
    if (capability === 'sleep_on_off') overrides.sleep = value ? 'on' : 'off';
    if (capability === 'onoff') overrides.onoff = value;
    //if (capability === 'fan_mode') overrides.fan_mode = value;

    // Auto encendido si corresponde
    if (capability === 'target_temperature' && autoOn) {
      const hvac = this.getCapabilityValue('thermostat_mode');
      if (!hvac || hvac === 'off') {
        this.log('Auto-on: Activando modo cool automáticamente.');
        await this.setCapabilityValue('thermostat_mode', 'cool');
        overrides.hvac_mode = 'cool';
      }
    }

    const payload = this.getCurrentState(overrides);
    this.log(`📦 Payload generado (capability: ${capability}):`, JSON.stringify(payload, null, 2));

  // Armamos URL según modo
  let url = `http://${ip}:${puerto}/api/webhook/`;
  if (learning) {
    url += 'ac_learn';
    this.learningMode = false;
  } else {
    if (capability !== 'thermostat_mode' && payload.hvac_mode === 'off') {
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
