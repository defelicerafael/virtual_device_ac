'use strict';

const Homey = require('homey');
const crypto = require('node:crypto');

class AcDriver extends Homey.Driver {

  async onInit() {
    this.log('AcDriver inicializado');
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
        },
      };
    });
  }

}

module.exports = AcDriver;
