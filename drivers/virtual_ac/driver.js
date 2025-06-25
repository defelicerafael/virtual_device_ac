const Homey = require("homey");

class VirtualACDriver  extends Homey.Driver {
  // this method is called when the app is started and the Driver is inited
  async onInit() {
     this.log('VirtualACDriver has been initialized');

      
  }
  
  
  // This method is called when a user is adding a device
  // and the 'list_devices' view is called
  async onPairListDevices() {
    return [
      {
        name: "Virtual Air Conditioner",
        data: {
          id: "virtual_ac",
        },
      },
    ];
  }
}

module.exports = VirtualACDriver;