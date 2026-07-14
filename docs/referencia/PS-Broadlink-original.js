// =====================================================================
// COPIA DE REFERENCIA — HomeyScript "PS Broadlink" del Homey Pro San Fran
// Pegado por Fernán el 2026-07-13. NO se ejecuta desde acá.
// La nueva app com.panteasmart.devices debe absorber esta lógica.
// Análisis en ../ps-broadlink-analisis.md
// =====================================================================

// Define la URL del webhook en Home Assistant.
const ip_home_assistant = '192.168.88.101'
const limpiarCache = false;
const base_urlCode = 'https://script.google.com/macros/s/AKfycbwdO-s-kH9uKtYq8UG9p03kVUjKLVflvxUdaprqTP4hPZh0CsguVQgnC3wZaq5kxq5Q/exec?code=';
const globalVariableIRCommands = "BroadLinkIRCommands";
const learningModeButton = "Aprender AC"
const modeOnDevices = []; // Aires con comando de modo/ON separado. Ej: ["Aire Living"]. Vacio = ninguno.


// For testing from console purposes,
// when no arguments are passed.
let testDevice = "Aire Escritorio"; // Trigger device for testing
let testCapability = "thermostat_mode"
let testValue = true;  // Value for testing purposes
//let testDevice = '{ "variable":"isNight"}'; // variable for testing

// *************************************************
// For each Pantea SMART Homeyscript COPY FROM HERE.
// *************************************************

let testing = false;
let psGV = global.get("PanteaSmart_Global")
let slConfig = global.get(psGV.cons.panteaSmartLightConfig);

let debugDetail = global.get(psGV.cons.debugDetail);

if (typeof(debugDetail) == "undefined" || debugDetail == null)
  debugDetail = false;
if(typeof(args[0]) == "undefined")
{
  if(typeof(testing) != "undefined")
  {
    testing = true;
    let debugDetailDescription = "";
    if (debugDetail == 0)
      debugDetailDescription = "0: Only action devices changes"
    else if (debugDetail == 1)
      debugDetailDescription = "1: Only action/sensors devices changes + global variable changes"
    else if (debugDetail == 2)
      debugDetailDescription = "2: Action/Sensors devices + global variable + aditional details"
    else if (debugDetail == 3)
      debugDetailDescription = "3: DebugDetail for Flows (except periodic Flows)"
    else if (debugDetail == 4)
      debugDetailDescription = '4: DebugDetail for All Flow (including periodic Flows as "PS L. Auto-Off")'

    console.log("debugDetail: " + debugDetailDescription);
  }
  if(typeof(testDevice) != "undefined")
    args = [testDevice];
  else
    args = [""];
}

let devices = await Homey.devices.getDevices();
let zones = await Homey.zones.getZones();
let systemInfo = await Homey.system.getInfo();
let triggerDevice = null;

if (typeof(args[0]) == "string" && Number.isNaN(Number(args[0])))
{
  triggerDevice = args[0];
  if(triggerDevice.startsWith("{") && triggerDevice.endsWith("}"))
    try { triggerDevice = JSON.parse(triggerDevice); }
    catch(error) {exception(`Error en arg. JSON: ${triggerDevice}`)}
  else if (triggerDevice.length == "36" && triggerDevice.split("-").length == 5)
    triggerDevice = { id: triggerDevice };
  else if (triggerDevice != "" && triggerDevice != null && typeof(triggerDevice) != "undefined")
    triggerDevice = { name: triggerDevice };

  if (triggerDevice != "" && triggerDevice != null && typeof(triggerDevice) != "undefined"
      && (typeof(triggerDevice.id) != "undefined" || typeof(triggerDevice.name) != "undefined" ))
    triggerDevice = getDevice(triggerDevice);

  if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS && triggerDevice.name != undefined)
    log("Triggered with " + triggerDevice.name);
  else if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS && triggerDevice.id != undefined)
    log("Triggered with " + triggerDevice.id);
  else if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS && triggerDevice.variable != undefined)
    log("Triggered with variable " + triggerDevice.variable);
  else if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS)
    log("Triggered with " + JSON.stringify(triggerDevice));

}

function dateFormat(dateToFormat)
{
  if(typeof(dateToFormat == "string"))
    dateToFormat = new Date(dateToFormat);
  return dateToFormat.toLocaleString("es-AR", {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, minute:'2-digit', second:'2-digit', timeZone: systemInfo.timezone});
}

function simpleLog(message, groupName, severity, facility) {
  Homey.flow.runFlowCardAction({
    uri: 'homey:flowcardaction:homey:app:nl.nielsdeklerk.log:Input_group_log',
    id: 'homey:app:nl.nielsdeklerk.log:Input_group_log',
    args: {
      log: message,
      group: groupName,
      severity: severity,
      facility: facility
    }
  })
  .then(() => {
    // Acción completada correctamente
  })
  .catch((error) => {
    console.error("Error al ejecutar runFlowCardAction:", error);
  });
}

function log(message, groupName, severity, facility)
{
// Severity: Emergency=0 Alert=1 Critical=2 Error=3 Warning=4 Notice=5 Informational=6 Debug=7
// Facility: 0 kernel, 1 user, 2 mail, 3 system, 4 authorisation, 5 syslog,
// 6 LPR, 7 News, 8 UUCP, 9 Cron, 10 Deamon, 11 FTP, 12 NTP,
// 13 Security, 14 Console, 15 Clock, 16 Flow, 17 Device,
// 18 App, 19 Scene, 20 Trigger, 21 Condition, 22 Action

  let logToConsole = false;
  if(typeof(testing) != "undefined" && testing)
    logToConsole = true;

  if(groupName == undefined)
    if(triggerDevice != null && triggerDevice.name != undefined && triggerDevice.name != null)
      groupName = `${this.__filename__} / ${triggerDevice.name}`;
    else if (triggerDevice != null && triggerDevice.variable != undefined)
      groupName = `${this.__filename__} / ${triggerDevice.variable}`;
    else if (!logToConsole)
      groupName = this.__filename__;
  else groupName = groupName;
  if(severity == undefined) severity = 7;
  if(facility == undefined) facility = 14;

  if(logToConsole)
    if(typeof(groupName) == "undefined")
      console.log(message);
    else
      console.log(`${groupName}: ${message}`);
  else
    simpleLog(message, groupName, severity,facility);
}

function err(message, groupName, facility)
{
  log(message, groupName, 3, facility);
}

function exception(message, groupName, facility)
{
  log(message, groupName, 2, facility);
  throw new Error(message);
}

function logDevice(device, value, lastUpdated, deviceType, message)
{
  if(typeof(message) != "string")
    message = "";
  else
    message = message + " ";

  if(typeof(value) == "boolean")
    if(deviceType == "alarm_motion")
      value = value ? "ACTIVE" : "SAFE";
    else if(deviceType == "onoff")
      value = value ? "ON" : "OFF";
  let logMessage = `${message}${device.name}[${deviceType}] = ${value}, lastUpdated: ${dateFormat(lastUpdated)}, available: ${device.available}`;
  if(typeof(testing) != "undefined" && testing)
    logMessage = logMessage + "\n\n";
  log(logMessage);
}

async function refresh()
{
  devices = await Homey.devices.getDevices();
  zones = await Homey.zones.getZones();
  systemInfo = await Homey.system.getInfo();
}

function getDevice(deviceArg)
{
  if(typeof(deviceArg) == "string")
    deviceArg = {name:deviceArg};

  if(deviceArg.id != undefined && deviceArg.id != null)
    for(let device of Object.values(devices))
    {
      if (deviceArg.id === device.id)
        return device;
    }

  let zoneId;

  if(deviceArg.zone != undefined && deviceArg.zone != null)
  {
    for(let zone of Object.values(zones))
    {
      if(deviceArg.zone === zone.name)
        zoneId = zone.id;
    }
  }

  for(let device of Object.values(devices))
  {
    if (deviceArg.name === device.name &&
        (typeof(deviceArg.zone) == "undefined" || deviceArg.zone == zoneId ))
      return device;
  }

  err(`Device ${deviceArg.name}${deviceArg.zone != undefined?", zone "+deviceArg.zone:""} not found ${deviceArg.id != undefined? "(id: "+deviceArg.id+")":""}`,undefined,3);

  // If no device was found, restart DeviceCapabilities which is
  // the App that sends the name or ID of the device.
  Homey.apps.restartApp("nl.qluster-it.DeviceCapabilities");

}

function getValue(device, dismissWhenDead, specificCapability)
{
  if (typeof(dismissWhenDead) != "boolean")
    dismissWhenDead = false;

  let possibleCapabilities = ["alarm_motion","alarm_contact","alarm_presence","onoff"];

  if (typeof(specificCapability) == "string")
    possibleCapabilities = [specificCapability];

  let value, lastUpdated, deviceType;

// If executed in testing mode (from Homeyscript console)
  let test = false;
  if (typeof(testing) != "undefined" && testing
      && typeof(testValue) != "undefined")
    test = true;

  if(typeof(device) == "undefined" || device == null)
    exception("Device null in getValue()");
  else if (typeof(device.capabilitiesObj) == "undefined" || device.capabilitiesObj == null)
    exception("Device object not having capabilitiesObj in getValue(): " + JSON.stringify(device));

  for(const capability of possibleCapabilities)
  {
    if(typeof(device.capabilitiesObj[capability]) != "undefined")
    {
      if (test && typeof(testDevice) != "undefined" &&
          device.name == testDevice &&
          ["alarm_motion","alarm_contact","alarm_presence","onoff"].includes(capability))
        value = testValue;
      else
        value = device.capabilitiesObj[capability].value;
      lastUpdated = device.capabilitiesObj[capability].lastUpdated;
      deviceType = device.capabilitiesObj[capability].id;
      break;
    }
  }

  let actualTime = new Date();

  if(value && !device.available && dismissWhenDead && !test)
  {
    if (debugDetail >= psGV.enum.debugDetail.DETAILS)
      log(`${device.name}: Dismissed - available: ${device.available}`);
    return false, lastUpdated;
  }

/* If the time the sensor has been active is greater than sensorDismissMinutes,
   within the deviceType defined, it's been considered deactivated with value = false */
  let minutesForDismiss = psGV.sensorDismissMinutes[deviceType];
  if (Array.isArray(psGV.sensorDismissMinutes.device))
  {
    for (const deviceDismissInfo of psGV.sensorDismissMinutes.device)
    {
      if (device.name == deviceDismissInfo.name && deviceType == deviceDismissInfo.capability)
      {
        minutesForDismiss = deviceDismissInfo.minutes;
        break;
      }
    }
  }
  if(typeof(minutesForDismiss) != "undefined" && value && actualTime - lastUpdated > minutesForDismiss * 60000 && !test)
  {
    value = false;
    if (debugDetail >= psGV.enum.debugDetail.DETAILS)
      log(`${device.name}: Dismissed ( ${minutesForDismiss} m)- upd: ${dateFormat(lastUpdated)}, ${deviceType}`);
  }

/*
--  Tambien se considera como desactivado si la fecha de actualización está dentro
--  de los 60 segundos de que se reinició el Home Center.
    elseif (modTime - psGlobalVariables.hc.initTime < 60  && debugDetail >= psGV.enum.debugDetail.DETAILS &&
         ( deviceType == "com.fibaro.doorSensor" ||
           deviceType == "com.fibaro.motionSensor")) then
      value = "0";
      log(`${triggerDevice}: Dismissed - upd: ${lastUpdated}, initHomeyTime: `);
    end
*/
  return [value, lastUpdated, deviceType];
}

function getValues(sensors, capability)
{
  if (typeof(sensors) == "undefined" || !Array.isArray(sensors))
  {
    err("Sensors array not valid for fx. getValues(), capability " + capability);
    return [undefined, undefined];
  }

  let values = { sum: 0, qty: 0, type: ""};

  for (sensor of sensors)
  {
    let dismissWhenDead = true;
    let sensorDevice = getDevice(sensor);
    if (sensorDevice == null)
      continue;
    let [value, lastModif, deviceType] = getValue(sensorDevice, dismissWhenDead, capability)
    if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS) logDevice(sensorDevice, value, lastModif, deviceType);

    if (value != null)
    {
      values.type = typeof(value);
      values.qty++;
      if (values.type  == "number")
        values.sum += value;
      else if (values.type == "boolean")
      {
        if (value)
          values.sum++;
      }
    }

  }

  let value = 0;

  if (values.type == "number")
    value = values.sum / values.qty;
  else if (values.type == "boolean")
  {
    if (values.sum == values.qty)
      value = true;
    else if (values.sum == 0 && values.qty > 0)
      value = false;
    else
      value = null;
  }
  else if (values.type == "")
    value = undefined;

  let printValue;
  if (values.type == "boolean" && value == null)
    printValue = "true and false";
  else
    printValue = value;

  return [value, printValue];

}

async function setOnOff(light, value, fromWhere, globalVariable)
{
  if (typeof(fromWhere) != "string")
    fromWhere = "";
  else
    fromWhere = fromWhere + ": ";

  if (typeof(value) == "number" && !light.capabilities.includes('dim'))
    value = value > 0;

  let hasGlobalVariable = false;

  if(typeof(globalVariable) != "undefined" && globalVariable != null
     && typeof(globalVariable.updating) != "undefined"
     && typeof(globalVariable.value) != "undefined")
  {
    hasGlobalVariable = true;
  }
  /*else if (value == false || value == 0)
  {
  // If is turning OFF the light without global variable, and there exists
  // a globalVariable for the light, update globalVariable anyway.

    globalVariable = await global.get(light.id);
    if(typeof(globalVariable) != "undefined" && globalVariable != null
      && typeof(globalVariable.updating) != "undefined"
      && typeof(globalVariable.value) != "undefined")
      hasGlobalVariable = true;
  }*/
  if (hasGlobalVariable)
  {
//  Setting globalVariable.updating to true, so that the device
//  won't update the globalVariable when status is changed.
    globalVariable.updating = true;
    globalVariable.value = 0;
    globalVariable.lastUpdate = new Date();
    await global.set(light.id, globalVariable);
    if(debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS)
      log(`${light.name}: setting globalVariable.updating = ${globalVariable.updating} - lastUpdate: ${dateFormat(globalVariable.lastUpdate)}`);

  }

  let printValue = "";

  if (typeof(value) == "number" && value > 1)
  {
    printValue = `ON (${value}%)`;
    value = value / 100;
  }
  else
    printValue = value ? "ON" : "OFF";

  let retries = 5;
  let actualValue = null;

  for (i=0; actualValue != value && i < retries; i++)
  {
    let errorFound = false;

    let capability = typeof(value) == "number"? "dim" : "onoff";

    if (i>0 && debugDetail >= psGV.enum.debugDetail.DETAILS)
      log(`${fromWhere}Retrying sending ${value} to ${light.name}. Actual value: ${actualValue}`);

    try
    {
      await Homey.devices.setCapabilityValue({
        deviceId: light.id,
        capabilityId: capability,
        value: value
      })
    }
    catch(error)
    {
      errorFound = true;
      if (hasGlobalVariable)
        err(`${fromWhere}ERROR Turning ${printValue} ${light.name}, with globalVariable.value = ${globalVariable.value}: ${error}`);
      else
        err(`${fromWhere}ERROR Turning ${printValue} ${light.name}, without globalVariable: ${error}`);
    }

    await wait(500); // Wait 1 secs
    await refresh();
    light = getDevice(light);
    [actualValue] = getValue(light,true,capability);
    if (capability == "dim" && Math.abs(actualValue - value) <= 0.02)
      actualValue = value;

    if (errorFound && actualValue == value)
      errorFound = false;

    if (!hasGlobalVariable && !errorFound)
      log(`${fromWhere}Turned ${printValue} ${light.name}, without globalVariable`);

    if (hasGlobalVariable)
    {
      // Setting globalVariable.value to 1 only if turned ON,
      // has globalVariable and no errors ocurred.
      if (value && !errorFound)
        globalVariable.value = 1;

      globalVariable.updating = false;
      globalVariable.lastUpdate = new Date();
      global.set(light.id, globalVariable);

      if (!errorFound)
        log(`${fromWhere}Turned ${printValue} ${light.name}, updating globalVariable.value = ${globalVariable.value}`);

    }
  }
}

function evalGlobalVariableConditions(name, conditions)
{
  let conditionsOK = true;

  if(Array.isArray(conditions))
  {
    for(condition of conditions)
    {
      if (typeof(condition) != "undefined" && condition != null &&
          typeof(condition.variable) != "undefined")
      {
        let globalValue = global.get(condition.variable);

        if (globalValue == "null")
          globalValue = null;

        if (globalValue == null && typeof(condition.value) == "boolean")
          globalValue = false;

        if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS)
          log(name + ": Variable " + condition.variable + " (" + globalValue + ") " + condition.cond  + " " + condition.value + "?");

    // if this check is true, continue with evaluation of sensors.
        if ((condition.cond == "==" && globalValue == condition.value)
        || (condition.cond == ">" && globalValue > condition.value)
        || (condition.cond == "<" && globalValue < condition.value)
        || (condition.cond == ">=" && globalValue >= condition.value)
        || (condition.cond == "<=" && globalValue <= condition.value)
        || (condition.cond == "!=" && globalValue != condition.value && globalValue != null))
        {
          //Just continue
        }
      // If is not true, return false because conditions are not OK.
        else
        {
          conditionsOK = false;
          break;
        }
      }
      if (typeof(condition) != "undefined" && condition != null &&
          typeof(condition.sensors) != "undefined" && typeof(condition.capability) != "undefined")
      {
        let [value, printValue] = getValues(condition.sensors, condition.capability);
        if (debugDetail >= psGV.enum.debugDetail.DEBUG_DETAILS)
          log(name + ": Sensors " + condition.capability + " (" + printValue + ") " + condition.cond  + " " + condition.value + "?");

    // if this check is true, continue with evaluation of sensors.
        if ((condition.cond == "==" && value == condition.value)
        || (condition.cond == ">" && value > condition.value)
        || (condition.cond == "<" && value < condition.value)
        || (condition.cond == ">=" && value >= condition.value)
        || (condition.cond == "<=" && value <= condition.value)
        || (condition.cond == "!=" && value != condition.value))
        {
          //Just continue
        }
      // If is not true, return false because conditions are not OK.
        else
        {
          conditionsOK = false;
          break;
        }
      }

    }
  }

  return conditionsOK;
}

async function getLog(device, capability)
{
  return await Homey.insights.getLogEntries({ id:"homey:device:"+ device.id + ":" + capability});
}

async function getLastlog(device, capability, n)
{
  if(typeof(n) != "number")
    n = 0;
  let history = await getLog(device, capability);
  return history.values[history.values.length-1-n];
}

// Function to send a push notification with error handling
async function sendPushNotification(message, user = null) {
  try {
    let targetUser;

    // If no user is provided, get the user executing the script
    if (!user) {
      targetUser = await Homey.users.getUserMe();

      // Check if the user was retrieved
      if (!targetUser) {
        throw new Error('Could not retrieve the current user.');
      }
    } else {
      // If a user is provided, use that user
      targetUser = user;
    }

    // Send the push notification to the appropriate user
    await Homey.flow.runFlowCardAction({
      id: 'homey:manager:mobile:push_text',
      args: {
        user: targetUser,
        text: message
      }
    });


  } catch (error) {
    // Log the error and return a message
    err(`Failed to send push notification: ${error.message}`);
  }
}

// *************************************************
// For each Pantea SMART Homeyscript COPY TO HERE.
// *************************************************

let parameters = args[0];

if(parameters.startsWith("{") && parameters.endsWith("}"))
  try { parameters = JSON.parse(parameters); }
  catch(error) {exception(`Error en arg. JSON: ${parameters}`)}

//log(JSON.stringify(triggerDevice.capabilities));
let capability;
if (testing)
  capability = testCapability;
else
  capability = parameters.capability;

async function getIRCommand(code, modeOnly)
{
  let globalIRCommands = global.get(globalVariableIRCommands);
  if (globalIRCommands == null)
  {
    globalIRCommands = [];
    globalIRCommands[code] = {};
  }
  else if (globalIRCommands[code] == null)
    globalIRCommands[code] = {};

  console.log(globalIRCommands);
/* Si todavía no tiene en memoria los comandos para ese código de IR,
 * los busco en el google Spreadsheet. */
  let searchCommand;
  if (modeOnly || hvac_mode == "off")
    searchCommand = hvac_mode;
  else
    searchCommand = hvac_mode+"_"+fan_mode+"_"+temperature+"_"+sleep;

  if (JSON.stringify(globalIRCommands[code]) == "{}" || globalIRCommands[code][searchCommand] == null)
  {
    let url_code = base_urlCode + code;
    const res = await fetch(url_code, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText} - Body: ${text}`);
    }

    // A veces Apps Script responde con Content-Type raro.
    // Probamos json(); si falla, hacemos parse manual.
    let ir_commands;
    try {
      ir_commands = await res.json();
    } catch (e) {
      const text = await res.text();
      ir_commands = JSON.parse(text);
    }

    for(let ir_command of Object.values(ir_commands))
    {
      if(ir_command.mode != null && ir_command.irCommand != null)
      {
        if(ir_command.mode == "off" || !ir_command.temp)
        {
          globalIRCommands[code][ir_command.mode] = ir_command.irCommand;
        }
        else
        {
          globalIRCommands[code][ir_command.mode+"_"+ir_command.fan+"_"
          +ir_command.temp+"_"+ir_command.sleep] = ir_command.irCommand;
        }
      }
    }

    // Grabamos en memoria los comandos IR para ese código.
    global.set(globalVariableIRCommands,globalIRCommands);

  }
  else if (limpiarCache)
    // Borramos de memoria los comandos IR para testeo.
    global.set(globalVariableIRCommands,null);


  let irSendingCommand = globalIRCommands[code][searchCommand];

  console.log("Code " + code + ", command " + searchCommand + ": " + irSendingCommand);

  //console.log('Respuesta JSON:'+ JSON.stringify(ir_codes));
  return irSendingCommand;
}


if (triggerDevice.name.substring(0,4).toLowerCase() != "aire")
  return;

let remote_entity;

if (parameters.remote_entity != null)
  remote_entity = parameters.remote_entity;
else
  remote_entity = "remote." + triggerDevice.name.substring(5).toLowerCase().replaceAll(" ","_");
//log(JSON.stringify(triggerDevice.capabilities))

let [temperature] = getValue(triggerDevice, false, 'target_temperature');
let [hvac_mode] = getValue(triggerDevice, false, 'thermostat_mode');
let [code] = getValue(triggerDevice, false, 'measure_data_size');

let [sleep] =  getValue(triggerDevice, false, 'onoffbuttontab_devicecapabilities_button-custom_31.boolean1');
let [device] = getValue(triggerDevice, false, 'measure_devicecapabilities_slider_number.number2');
let [fan_mode] = getValue(triggerDevice, false, 'devicecapabilities_picker-auto-low-medium-high-turbo_list');
let [swing] =  getValue(triggerDevice, false, 'onoffbuttontab_devicecapabilities_button-custom_19.boolean2');

let learningButton = getDevice(learningModeButton)
let [learning] = getValue(learningButton);

// Aire con comando de modo separado Y lo que cambio fue el modo (encendido en un modo)?
let modeOn = modeOnDevices.includes(triggerDevice.name)
          && capability == "thermostat_mode"
          && hvac_mode != "off";

if (device == null)
  device = 1;
device = 'ac' + device;

if (sleep == null)
  sleep = 'off';
else
  sleep = sleep? 'on':'off';

if (fan_mode == null)
  fan_mode = "auto";

if (swing == null)
  swing = 'on';
else
  swing = swing? 'on':'off';

log("remote_entity: " + remote_entity + ", device: " + device);
log("learning?: " + learning);
if(capability == "swing")
  log("swing: " + swing);
else
  log("temp: "+ temperature + ", hvac_mode: "+ hvac_mode + ", sleep: " + sleep + ", fan_mode: "+fan_mode);

let url = `http://${ip_home_assistant}:8123/api/webhook/`;

if (learning)
{
  url = url + 'ac_learn'
  setOnOff(learningButton, false, "PS AC Controller")
}
else
  url = url + 'ac_command'

log("URL: "+url);

if (capability != "thermostat_mode" && hvac_mode == "off")
{
  log(triggerDevice.name + " en off, no se envia nada.");
  return;
}

// ====== ENVIO / APRENDIZAJE ======

async function postCommand(payload) {
  console.log(payload);
  let options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
  return fetch(url, options)
    .then(r => r.ok ? console.log("Webhook OK") : console.error("Error:", r.statusText))
    .catch(e => console.error("Error al ejecutar el webhook:", e));
}

async function buildFullPayload() {
  let p = { remote_entity: remote_entity };
  let command = await getIRCommand(code);
  if (typeof(command) == "string" && command.trim() != "") {
    p.command_code = command;
  } else {
    p.device = device;
    p.hvac_mode = hvac_mode;
    p.fan_mode = fan_mode;
    p.sleep = sleep;
    p.temperature = temperature;
  }
  return p;
}

if (modeOn) {
  if (learning) {
    // En aprendizaje se aprende el comando de modo (HA aprende ir_{dev}_{modo})
    await postCommand({ remote_entity: remote_entity, device: device, hvac_mode: hvac_mode, simple_mode: true });
  } else {
    // Enviar: planilla (command_code) con fallback a por-nombre -> wait 2s -> completo
    let modeCmd = await getIRCommand(code, true);
    let modePayload = { remote_entity: remote_entity };
    if (typeof(modeCmd) == "string" && modeCmd.trim() != "") {
      modePayload.command_code = modeCmd;
    } else {
      modePayload.device = device;
      modePayload.hvac_mode = hvac_mode;
      modePayload.simple_mode = true;
    }
    await postCommand(modePayload);
    await wait(2000);
    await postCommand(await buildFullPayload());
  }
} else {
  await postCommand(await buildFullPayload());
}
