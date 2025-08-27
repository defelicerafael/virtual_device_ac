'use strict';

const Homey = require('homey');

module.exports = class PanteaVirtualAC extends Homey.Device {

  async onInit() {
  this.log('Pantea Virtual AC inicializado:', this.getName());

  // Estado interno
  this.learningMode = false;
  this.lastThermostatMode = (await this.getStoreValue('last_mode')) || 'cool';

  // Flag anti-doble envío entre onoff/thermostat_mode
  this._fromOnOffUpdate = false;

  // Normalizar ON/OFF en el arranque
  const currentOn = this.getCapabilityValue('onoff');
  if (currentOn === null || typeof currentOn === 'undefined') {
    await this.setCapabilityValue('onoff', false);
  }

  // -------------------------------
  // Listener ONOFF
  // -------------------------------
  this.registerCapabilityListener('onoff', async (value) => {
    if (value) {
      const stored = await this.getStoreValue('last_mode');
      const lastMode = (this.lastThermostatMode && typeof this.lastThermostatMode === 'string')
        ? this.lastThermostatMode
        : (stored || 'cool');

      if (this.getCapabilityValue('thermostat_mode') !== lastMode) {
        this._fromOnOffUpdate = true;
        await this.setCapabilityValue('thermostat_mode', lastMode);
        this._fromOnOffUpdate = false;
      }
      this.log('ON → lastMode:', lastMode);

    } else {
      if (this.getCapabilityValue('thermostat_mode') !== 'off') {
        this._fromOnOffUpdate = true;
        await this.setCapabilityValue('thermostat_mode', 'off');
        this._fromOnOffUpdate = false;
      }
      this.log('OFF → thermostat_mode off');
    }

    // 📡 Un único POST con payload completo (incluye onoff + hvac_mode + temp + swing + sleep)
    await this.sendCommand('onoff', value);

    return true;
  });

  // -------------------------------
  // Listener Target Temperature
  // -------------------------------
  this.registerCapabilityListener('target_temperature', async (value) => {
    await this.sendCommand('target_temperature', value);
    return Promise.resolve();
  });

  // -------------------------------
  // Listener Measure Temperature
  // -------------------------------
  this.registerCapabilityListener('measure_temperature', async (value) => {
    await this.sendCommand('measure_temperature', value);
    return Promise.resolve();
  });

  // -------------------------------
  // Listener Thermostat Mode
  // -------------------------------
  this.registerCapabilityListener('thermostat_mode', async (value) => {
    if (value !== 'off') {
      this.lastThermostatMode = value;
      await this.setStoreValue('last_mode', value);
    }

    // Sincronizar onoff solo si cambia
    const wantOn = (value !== 'off');
    if (this.getCapabilityValue('onoff') !== wantOn) {
      await this.setCapabilityValue('onoff', wantOn);
    }

    // Evitar doble envío si vino de onoff
    if (this._fromOnOffUpdate) {
      return true;
    }

    // Cambio directo de modo → mandar comando
    await this.sendCommand('thermostat_mode', value);
    return Promise.resolve();
  });

  // -------------------------------
  // Listener Learning Mode (botón)
  // -------------------------------
  this.registerCapabilityListener('learning_mode', async value => {
    this.log('Learning mode button pressed:', value);
    if (value) {
      this.learningMode = true;
      await this.sendCommand('learn', null);
      await this.setCapabilityValue('learning_mode', false); // reset botón
    }
    return Promise.resolve();
  });

  // -------------------------------
  // Listener Sleep ON/OFF
  // -------------------------------
  this.registerCapabilityListener('sleep_on_off', async value => {
    this.log('sleep_on_off button pressed:', value);
    await this.sendCommand('sleep_on_off', value);
    return Promise.resolve();
  });

  // -------------------------------
  // Listener Swing ON/OFF
  // -------------------------------
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

      // Validaciones simples
      if (changedKeys.includes('ha_ip') && !newSettings.ha_ip) {
        this.log('⚠️ ha_ip vacío: no se podrán enviar comandos.');
      }
      if (changedKeys.includes('remote_entity_name') && !newSettings.remote_entity_name) {
        this.log('⚠️ remote_entity_name vacío: no se podrán enviar comandos.');
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
      onoff: overrides.onoff ?? (this.getCapabilityValue('onoff') === true),
      // fan_mode: overrides.fan_mode ?? this.getCapabilityValue('fan_mode') ?? 'auto',
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

  // Overrides según qué capability cambió
  const overrides = {};
    if (capability === 'target_temperature') overrides.temperature = value;
    if (capability === 'thermostat_mode') overrides.hvac_mode = value;
    if (capability === 'swing_on_off') overrides.swing = value ? 'on' : 'off';
    if (capability === 'sleep_on_off') overrides.sleep = value ? 'on' : 'off';
    if (capability === 'onoff') overrides.onoff = value;
  // if (capability === 'fan_mode') overrides.fan_mode = value;

  // --- LÓGICA DE AUTO-ENCENDIDO MEJORADA ---
  if (capability === 'target_temperature' && autoOn) {
    const hvac = this.getCapabilityValue('thermostat_mode');
    if (!hvac || hvac === 'off') {
      const modeToSet = this.lastThermostatMode === 'off' ? 'cool' : this.lastThermostatMode;
      this.log(`Auto-on: Activando modo '${modeToSet}' automáticamente.`);
      
      this._fromOnOffUpdate = true;
      await this.setCapabilityValue('thermostat_mode', modeToSet);
      await this.setCapabilityValue('onoff', true);
      this._fromOnOffUpdate = false;

      overrides.hvac_mode = modeToSet;
      overrides.onoff = true;
    }
  }

  // Lógica de "refuerzo" (sin cambios, aún es útil)
  if (capability === 'target_temperature') {
    const hvacEff = overrides.hvac_mode ?? this.getCapabilityValue('thermostat_mode');
    const onoffCap = this.getCapabilityValue('onoff');
    const hvacIsOn = (hvacEff && hvacEff !== 'off');
    const onoffIsTrue = (onoffCap === true) || (overrides.onoff === true);

    if (hvacIsOn && !onoffIsTrue) {
      await this.setCapabilityValue('onoff', true);
      overrides.onoff = true;
      this.log('Refuerzo: ON por cambio de temperatura con hvac activo.');
    }
  }

  const payload = this.getCurrentState(overrides);
  this.log(`📦 Payload generado (capability: ${capability}):`, JSON.stringify(payload, null, 2));

  // URL según modo
  let url = `http://${ip}:${puerto}/api/webhook/`;
  if (learning) {
    url += 'ac_learn';
    this.learningMode = false;
  } else {
    // Permitir mandar OFF si viene de thermostat_mode u onoff
    if (payload.hvac_mode === 'off' && !['thermostat_mode', 'onoff'].includes(capability)) {
      this.log(`${this.getName()} en off, no se envía comando para ${capability}.`);
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
    try {
      this.log(`Modo aprendizaje (interno): ${enable}`);
      this.learningMode = !!enable;

      // Si me piden desactivar, solo apago el flag y salgo
      if (!this.learningMode) return;

      // Si está activado, disparo el webhook de aprendizaje
      await this.sendCommand('learn', null);

    } catch (err) {
      this.error('Error en setLearningMode:', err);
      // Por las dudas, no dejar el flag colgado en true si falló el envío
      this.learningMode = false;
    }
  }

};
