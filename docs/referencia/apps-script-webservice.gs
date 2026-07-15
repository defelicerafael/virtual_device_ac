// =====================================================================
// COPIA DE REFERENCIA — Apps Script del webservice de la planilla de
// códigos IR (Google Spreadsheet). Pegado por Fernán el 2026-07-15.
// NO se ejecuta desde acá: vive en script.google.com (cuenta de Fernán)
// y se publica como Web App (URL en settings de la app, def. 15).
//
// Endpoints:
//   GET ?code={n}   → filas de la hoja "codes" para ese code
//   GET ?marcas={n} → filas de la hoja "Marcas" para ese code (wizard)
//
// extraerAC1(): utilitario del proceso de la def. 14 — parsea el JSON de
// la integración Broadlink de HA (claves ir_ac1_<modo>_<fan>_<temp>_<sleep>)
// pegado en la columna A y lo vuelca como filas Mode/Fan/Temp/Sleep/ir_code.
// =====================================================================

function json(code) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  const sheet = spreadsheet.getSheetByName("codes")
  const data = sheet.getDataRange().getValues();
  const jsonData = convertToJson(data, code)
  return ContentService.createTextOutput
        (JSON.stringify(jsonData))
        .setMimeType(ContentService.MimeType.JSON)
}

function convertToJson(data, code) {
  const headers = data[0]
  const raw_data = data.slice(1,)
  let json = []
  raw_data.forEach(d => {
      if (d[0] == code)
      {
        let object = {}
        for (let i = 0; i < headers.length; i++) {
          object[headers[i]] = d[i]
        }
        json.push(object)
      }
  });
  return json
}

function doGet(e) {
  const code = e.parameter.code;

  if (e.parameter.marcas) {
      return marcasJson_(e.parameter.marcas);
  }

  return json(code) ;
}

function marcasJson_(code) {
  const hoja = SpreadsheetApp.getActive().getSheetByName('Marcas');
  const [headers, ...filas] = hoja.getDataRange().getValues();
  const colCode = headers.indexOf('code'); // ajustar al nombre real de la columna
  const result = filas
    .filter(f => String(f[colCode]) === String(code))
    .map(f => Object.fromEntries(headers.map((h, i) => [h, f[i]])));
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function extraerAC1() {
  const sh = SpreadsheetApp.getActiveSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error("No hay datos desde A2.");

  // 1) juntar JSON desde A2↓
  const lines = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
    .map(r => (r[0] ?? "").toString())
    .filter(v => v !== "");

  let txt = lines.join("\n").trim();

  // 2) normalizaciones típicas de pegado
  txt = txt.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // 3) poner comillas a claves no citadas
  txt = txt.replace(/(^|[{\[,]\s*)([A-Za-z0-9_.-]+)\s*:/gm, '$1"$2":');

  // 4) eliminar comas colgantes
  txt = txt.replace(/,(\s*[}\]])/g, '$1');

  // 5) parsear
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch (e) {
    throw new Error("JSON inválido: " + e.message);
  }

  if (!obj?.data?.ac1 || typeof obj.data.ac1 !== "object") {
    throw new Error('No encontré "data.ac1".');
  }

  const ac1 = obj.data.ac1;

  // 6) headers fijos
  const headers = ["Mode", "Fan", "Temp", "Sleep", "ir_code"];
  const out = [headers];

  // 7) filas
  Object.keys(ac1).forEach(fullKey => {
    const irCode = String(ac1[fullKey]);

    // ej: ir_ac1_cool_auto_25_on
    const tokens = fullKey.split("_");

    // ignorar prefijo "ir_ac1" (dos tokens: "ir" + "ac1")
    const parts = (tokens.length >= 2 && tokens[0] === "ir" && tokens[1] === "ac1")
      ? tokens.slice(2)
      : tokens;

    const thermostatMode = parts[0] ?? "";
    const fan = parts[1] ?? "";
    const temp = parts[2] ?? "";
    const sleepMode = parts[3] ?? "";

    out.push([thermostatMode, fan, temp, sleepMode, irCode]);
  });

  // 8) limpiar y escribir desde B1
  sh.getRange(1, 2, sh.getMaxRows(), sh.getMaxColumns() - 1).clearContent();
  sh.getRange(1, 2, out.length, out[0].length).setValues(out);
}
