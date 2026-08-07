'use strict';

const Homey = require('homey');
const crypto = require('node:crypto');

class AcDriver extends Homey.Driver {

  async onInit() {
    this._registerFlowCards();
    this.log('AcDriver inicializado');
  }

  /**
   * IP por defecto del PHM vía discovery del core de Homey (def. 25). El
   * discovery corre FUERA del contenedor de la app, por eso funciona donde
   * la resolución mDNS directa falla. Nunca se muestra al usuario ni se
   * menciona el servicio descubierto (def. 6).
   *
   * ⚠️ La estrategia se consulta por el MANAGER, no se declara en el driver
   * ("discovery" en driver.compose.json): declararla ata la DISPONIBILIDAD
   * de los devices al discovery — como los ids jamás matchean, el core los
   * marca "no disponibles" a todos (bug 2026-07-16, ver
   * docs/debug-modo-instalado.md).
   * @returns {{host: string, port: number}|null}
   */
  _discoverPhmDefault() {
    try {
      const strategy = this.homey.discovery.getStrategy('phm');
      const results = Object.values(strategy.getDiscoveryResults() || {});
      const found = results.find((result) => result && result.address);
      if (!found) return null;
      return { host: String(found.address), port: Number(found.port) || 8123 };
    } catch (err) {
      this.log('Discovery del PHM no disponible:', err.message || err);
      return null;
    }
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
    this.flowAutoOffSet = this.homey.flow.getDeviceTriggerCard('auto_off_set');
    this.flowAutoOffFinished = this.homey.flow.getDeviceTriggerCard('auto_off_finished');
    this.flowStateDetected = this.homey.flow.getDeviceTriggerCard('state_detected');

    // Conditions.
    this.homey.flow.getConditionCard('fan_speed_is')
      .registerRunListener(async ({ device, speed }) => device.getCapabilityValue('fan_mode') === speed);
    this.homey.flow.getConditionCard('swing_is')
      .registerRunListener(async ({ device, swing }) => device.getSwingKey() === swing);
    this.homey.flow.getConditionCard('sleep_is_on')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('sleep_on_off') === true);
    this.homey.flow.getConditionCard('auto_off_is_active')
      .registerRunListener(async ({ device }) => device.isAutoOffActive());

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
    this.homey.flow.getActionCard('set_auto_off')
      .registerRunListener(async ({ device, hours }) => {
        requireCapability(device, 'auto_off', this.homey.__({ en: 'This unit does not have the auto-off enabled.', es: 'Este equipo no tiene habilitado el apagado automático.' }));
        await device.triggerCapabilityListener('auto_off', Number(hours) || 0);
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
    // IP/puerto del PHM a nivel app (def. 24): el wizard los muestra de solo
    // lectura; si todavía no están configurados, el primer alta los pide y
    // los guarda como configuración de la app.
    session.setHandler('get_phm', async () => {
      const host = String(this.homey.settings.get('phm_host') || '').trim();
      const port = Number(this.homey.settings.get('phm_port')) || 8123;
      // hasDefault: hay un valor detectado para usar si dejan la IP vacía.
      // A propósito NO se envía cuál es (def. 25).
      const hasDefault = host === '' && this._discoverPhmDefault() != null;
      return { host, port, configured: host !== '', hasDefault };
    });

    const namesWithCapability = async (capability) => {
      try {
        const api = await this.homey.app.getHomeyApi();
        const devices = await api.devices.getDevices();
        const names = Object.values(devices)
          .filter((device) => Array.isArray(device.capabilities)
            && device.capabilities.includes(capability))
          .map((device) => device.name)
          .sort((a, b) => a.localeCompare(b));
        return [...new Set(names)];
      } catch (err) {
        this.error(`No se pudieron listar los devices con ${capability}:`, err.message || err);
        return [];
      }
    };

    session.setHandler('get_temp_devices', () => namesWithCapability('measure_temperature'));
    // Sensores de contacto para la aleta del split (def. 29).
    session.setHandler('get_contact_devices', () => namesWithCapability('alarm_contact'));

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
      const remoteEntity = required(form.remoteEntity, 'entidad remote')
        .toLowerCase().replace(/^remote\./, '');
      const code = String(form.code ?? '').trim();
      if (code !== '' && !/^\d+$/.test(code)) {
        throw new Error('El code debe ser un número (o vacío para modo legacy).');
      }

      // Primer alta sin IP configurada a nivel app: la siembra (def. 24).
      // Si el instalador la deja vacía, se usa el valor detectado por
      // discovery (def. 25); sin detección, la IP es obligatoria.
      const appHost = String(this.homey.settings.get('phm_host') || '').trim();
      if (appHost === '') {
        let host = String(form.host ?? '').trim();
        let port = Number(form.port) || 0;
        if (host === '') {
          const discovered = this._discoverPhmDefault();
          if (!discovered) throw new Error('Falta completar: IP de Pantea Home Manager.');
          host = discovered.host;
          port = port || discovered.port;
        }
        this.homey.settings.set('phm_host', host);
        this.homey.settings.set('phm_port', port || 8123);
      }

      return {
        name,
        data: { id: `pantea-ac-${crypto.randomUUID()}` },
        settings: {
          remote_entity: remoteEntity,
          code,
          temp_source: String(form.tempSource ?? '').trim(),
          auto_on: form.autoOn !== false,
          allow_heat: form.allowHeat !== false,
          allow_dry: form.allowDry === true,
          allow_fan_mode: form.allowFanMode === true,
          allow_sleep: form.allowSleep === true,
          allow_fan_speed: form.allowFanSpeed === true,
          swing_type: ['onoff', 'positions', 'none'].includes(form.swingType) ? form.swingType : 'onoff',
          auto_off_mode: ['none', 'device', 'ir'].includes(form.autoOffMode) ? form.autoOffMode : 'none',
          auto_off_max: 12,
          two_step_override: 'auto',
          learned_fan_override: 'auto',
          learn_temp_scope: 'range',
          learn_timer_scope: 'range',
          flap_source: String(form.flapSource ?? '').trim(),
          flap_inverted: false,
          discharge_temp_source: '',
          outdoor_temp_source: '',
          outdoor_cutoff: 19,
        },
      };
    });
  }

}

module.exports = AcDriver;
