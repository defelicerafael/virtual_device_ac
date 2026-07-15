'use strict';

const Homey = require('homey');
const crypto = require('node:crypto');

class AcDriver extends Homey.Driver {

  async onInit() {
    this._registerFlowCards();
    this.log('AcDriver inicializado');
  }

  /**
   * Flow cards propias (def. 19; §8 de la propuesta). Las de onoff /
   * thermostat_mode / target_temperature las genera Homey solo.
   */
  _registerFlowCards() {
    // Triggers (se disparan desde device.js tras un cambio exitoso).
    this.flowFanSpeedChanged = this.homey.flow.getDeviceTriggerCard('fan_speed_changed');
    this.flowSwingChanged = this.homey.flow.getDeviceTriggerCard('swing_changed');
    this.flowSleepOn = this.homey.flow.getDeviceTriggerCard('sleep_turned_on');
    this.flowSleepOff = this.homey.flow.getDeviceTriggerCard('sleep_turned_off');

    // Conditions.
    this.homey.flow.getConditionCard('fan_speed_is')
      .registerRunListener(async ({ device, speed }) => device.getCapabilityValue('fan_mode') === speed);
    this.homey.flow.getConditionCard('swing_is')
      .registerRunListener(async ({ device, swing }) => device.getSwingKey() === swing);
    this.homey.flow.getConditionCard('sleep_is_on')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('sleep_on_off') === true);

    // Actions: pasan por triggerCapabilityListener para recorrer el mismo
    // camino que un toque en el tile (envío incluido).
    const requireCapability = (device, capability, message) => {
      if (!device.hasCapability(capability)) throw new Error(message);
    };
    this.homey.flow.getActionCard('set_fan_speed')
      .registerRunListener(async ({ device, speed }) => {
        requireCapability(device, 'fan_mode', this.homey.__({ en: 'This unit does not allow changing fan speed.', es: 'Este equipo no permite cambiar la velocidad.' }));
        await device.triggerCapabilityListener('fan_mode', speed);
      });
    this.homey.flow.getActionCard('set_swing_onoff')
      .registerRunListener(async ({ device, state }) => {
        requireCapability(device, 'swing_on_off', this.homey.__({ en: 'This unit uses positional swing.', es: 'Este equipo usa swing por posición.' }));
        await device.triggerCapabilityListener('swing_on_off', state === 'on');
      });
    this.homey.flow.getActionCard('set_swing_position')
      .registerRunListener(async ({ device, position }) => {
        requireCapability(device, 'swing_mode', this.homey.__({ en: 'This unit uses on/off swing.', es: 'Este equipo usa swing on/off.' }));
        await device.triggerCapabilityListener('swing_mode', position);
      });
    this.homey.flow.getActionCard('set_sleep')
      .registerRunListener(async ({ device, state }) => {
        requireCapability(device, 'sleep_on_off', this.homey.__({ en: 'This unit does not allow sleep.', es: 'Este equipo no permite sleep.' }));
        await device.triggerCapabilityListener('sleep_on_off', state === 'on');
      });
  }

  /**
   * Wizard de pairing (defs. 3, 17, 21 y 5 v3): una vista custom (pair/setup.html).
   * Handlers que consume la vista:
   *  - get_temp_devices: nombres de devices con measure_temperature (drop-down)
   *  - check_code: resumen + marcas del code (consulta la planilla en vivo)
   *  - build_device: valida el formulario y arma el objeto device a crear
   */
  async onPair(session) {
    session.setHandler('get_temp_devices', async () => {
      try {
        const api = await this.homey.app.getHomeyApi();
        const devices = await api.devices.getDevices();
        const names = Object.values(devices)
          .filter((device) => Array.isArray(device.capabilities)
            && device.capabilities.includes('measure_temperature'))
          .map((device) => device.name)
          .sort((a, b) => a.localeCompare(b));
        return [...new Set(names)];
      } catch (err) {
        this.error('No se pudieron listar los sensores de temperatura:', err.message || err);
        return [];
      }
    });

    session.setHandler('check_code', async ({ code }) => {
      const clean = String(code ?? '').trim();
      if (clean === '') return { empty: true };
      if (!/^\d+$/.test(clean)) throw new Error('El code debe ser un número.');
      const summary = await this.homey.app.irCodes.getSummary(clean);
      const brands = await this.homey.app.irCodes.getBrands(clean);
      return { summary, brands };
    });

    session.setHandler('build_device', async (form) => {
      const required = (value, label) => {
        const clean = String(value ?? '').trim();
        if (clean === '') throw new Error(`Falta completar: ${label}.`);
        return clean;
      };

      const name = required(form.name, 'nombre del equipo');
      const host = required(form.host, 'host/IP de Pantea Home Manager');
      const remoteEntity = required(form.remoteEntity, 'entidad remote')
        .toLowerCase().replace(/^remote\./, '');
      const code = String(form.code ?? '').trim();
      if (code !== '' && !/^\d+$/.test(code)) {
        throw new Error('El code debe ser un número (o vacío para modo legacy).');
      }
      const port = Number(form.port) || 8123;

      return {
        name,
        data: { id: `pantea-ac-${crypto.randomUUID()}` },
        settings: {
          phm_host: host,
          phm_port: port,
          remote_entity: remoteEntity,
          code,
          temp_source: String(form.tempSource ?? '').trim(),
          auto_on: form.autoOn !== false,
          allow_heat: form.allowHeat !== false,
          allow_dry: form.allowDry !== false,
          allow_fan_mode: form.allowFanMode !== false,
          allow_sleep: form.allowSleep !== false,
          allow_fan_speed: form.allowFanSpeed !== false,
          swing_type: form.swingType === 'positions' ? 'positions' : 'onoff',
          two_step_override: 'auto',
          learned_fan_override: 'auto',
          learn_temp_scope: 'range',
        },
      };
    });
  }

}

module.exports = AcDriver;
