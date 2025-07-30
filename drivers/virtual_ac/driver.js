const Homey = require("homey");

class VirtualACDriver  extends Homey.Driver {
  // this method is called when the app is started and the Driver is inited
  async onInit() {
     this.log('VirtualACDriver has been initialized');
  }
  
  
  // This method is called when a user is adding a device
  // and the 'list_devices' view is called
  async onPairListDevices() {
    let counter = await this.homey.settings.get('device_counter') || 1;
    const deviceId = `pantea_virtual_ac_${counter}`;
    await this.homey.settings.set('device_counter', counter + 1);

    return [
      {
        name: `Pantea Virtual AC ${counter}`,
        data: {
          id: deviceId
        },
        settings: {
          ha_ip: "panteasmart.local",
          remote_entity_name: `pantea_ac_${counter}`,
          codigo_ac: "ac1",
          auto_on_temp_change: false,
          ha_port:8123
        }
      },
    ];
  }
}

module.exports = VirtualACDriver;