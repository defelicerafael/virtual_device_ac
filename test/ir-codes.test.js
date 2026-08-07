'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IrCodes = require('../lib/ir-codes');

const FIXTURES = {};
for (const code of [1, 2, 3, 4, 5]) {
  FIXTURES[code] = fs.readFileSync(path.join(__dirname, 'fixtures', `code${code}.json`), 'utf8');
}

// Fixtures sintéticos: la planilla real todavía no tiene filas timer_off_*
// (def. 28). Mismo formato que el webservice — filas mode-only, sin temp.
// 97: medias horas + el comando de cancelar. 98: solo horas enteras (el caso
// que obliga al slider a pasar a paso 1).
FIXTURES[97] = JSON.stringify([
  { code: 97, mode: 'off', fan: '', temp: '', sleep: '', irCommand: 'OFF97' },
  { code: 97, mode: 'cool', fan: 'auto', temp: 24, sleep: 'off', irCommand: 'COOL97' },
  { code: 97, mode: 'timer_off_00', fan: '', temp: '', sleep: '', irCommand: 'CANCEL97' },
  { code: 97, mode: 'timer_off_05', fan: '', temp: '', sleep: '', irCommand: 'T05_97' },
  { code: 97, mode: 'timer_off_10', fan: '', temp: '', sleep: '', irCommand: 'T10_97' },
  { code: 97, mode: 'timer_off_15', fan: '', temp: '', sleep: '', irCommand: 'T15_97' },
  { code: 97, mode: 'timer_off_120', fan: '', temp: '', sleep: '', irCommand: 'T120_97' },
]);
FIXTURES[98] = JSON.stringify([
  { code: 98, mode: 'off', fan: '', temp: '', sleep: '', irCommand: 'OFF98' },
  { code: 98, mode: 'timer_off_10', fan: '', temp: '', sleep: '', irCommand: 'T10_98' },
  { code: 98, mode: 'timer_off_20', fan: '', temp: '', sleep: '', irCommand: 'T20_98' },
  { code: 98, mode: 'timer_off_80', fan: '', temp: '', sleep: '', irCommand: 'T80_98' },
]);

const BASE_URL = 'https://ws.example/exec?code=';

/** fetch falso que sirve los fixtures reales del webservice y cuenta llamadas. */
function makeFetch({ failWith } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (failWith) throw failWith;
    // Como el webservice real de hoy: solo ?code= devuelve filas; ?marcas= da [].
    const match = /[?&]code=(\w+)$/.exec(url);
    const body = (match && FIXTURES[match[1]]) || '[]';
    return { ok: true, text: async () => body };
  };
  return { fetchFn, calls };
}

function makeService(fetchMock, extra = {}) {
  return new IrCodes({
    getBaseUrl: () => BASE_URL,
    fetchFn: fetchMock.fetchFn,
    ...extra,
  });
}

describe('IrCodes con fixtures reales del webservice', () => {
  let mock;
  let ir;

  beforeEach(() => {
    mock = makeFetch();
    ir = makeService(mock);
  });

  test('getFullCommand arma la clave {mode}_{fan}_{temp}_{sleep}', async () => {
    const cmd = await ir.getFullCommand(1, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' });
    assert.ok(typeof cmd === 'string' && cmd.startsWith('Jg'), 'devuelve un código IR base64');
  });

  test('getModeCommand devuelve el comando off (fila sin temp)', async () => {
    const cmd = await ir.getModeCommand(1, 'off');
    assert.ok(typeof cmd === 'string' && cmd.length > 50);
  });

  test('comando inexistente devuelve null (dispara fallback legacy)', async () => {
    assert.equal(await ir.getFullCommand(2, { mode: 'cool', fan: 'high', temp: 24, sleep: 'off' }), null);
    assert.equal(await ir.getFullCommand(999, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }), null);
  });

  test('code vacío/null devuelve null sin consultar el webservice', async () => {
    assert.equal(await ir.getModeCommand('', 'off'), null);
    assert.equal(await ir.getModeCommand(null, 'off'), null);
    assert.equal(mock.calls.length, 0);
  });

  test('cachea por code: un solo fetch para múltiples consultas', async () => {
    await ir.getModeCommand(1, 'off');
    await ir.getFullCommand(1, { mode: 'cool', fan: 'auto', temp: 20, sleep: 'off' });
    await ir.getSwingCommands(1);
    assert.equal(mock.calls.length, 1);
  });

  test('clearCache + reload re-consultan', async () => {
    await ir.getModeCommand(1, 'off');
    await ir.reload(1);
    assert.equal(mock.calls.length, 2);
  });

  test('autodetección 2 pasos: code 5 SÍ (filas heat/cool sin temp), codes 1-4 NO', async () => {
    assert.equal(await ir.hasModeOnlyRows(5), true);
    for (const code of [1, 2, 3, 4]) {
      assert.equal(await ir.hasModeOnlyRows(code), false, `code ${code}`);
    }
  });

  test('autodetección fan aprendido: code 1 SÍ (low/medium/high/turbo), code 2 NO', async () => {
    assert.equal(await ir.hasLearnedFan(1), true);
    assert.equal(await ir.hasLearnedFan(2), false);
  });

  test('swing: hoy la planilla no tiene filas swing_* en ningún code', async () => {
    const swing = await ir.getSwingCommands(1);
    assert.deepEqual(swing, {
      on: null, off: null, auto: null, up: null, middle: null, down: null,
    });
    assert.equal(await ir.getSwingCommand(1, 'up'), null);
    assert.equal(await ir.getSwingCommand(1, 'on'), null);
  });

  test('timerKey convierte horas a la clave de planilla (décimas, 2 dígitos mínimo)', () => {
    assert.equal(IrCodes.timerKey(0), 'timer_off_00');
    assert.equal(IrCodes.timerKey(0.5), 'timer_off_05');
    assert.equal(IrCodes.timerKey(1), 'timer_off_10');
    assert.equal(IrCodes.timerKey(1.5), 'timer_off_15');
    assert.equal(IrCodes.timerKey(9.5), 'timer_off_95');
    assert.equal(IrCodes.timerKey(12), 'timer_off_120');
  });

  test('timerHours es la inversa y descarta claves que no son de auto-apagado', () => {
    assert.equal(IrCodes.timerHours('timer_off_05'), 0.5);
    assert.equal(IrCodes.timerHours('timer_off_120'), 12);
    assert.equal(IrCodes.timerHours('swing_up'), null);
    assert.equal(IrCodes.timerHours('cool_auto_24_off'), null);
    assert.equal(IrCodes.timerHours('timer_off_dos'), null);
    assert.equal(IrCodes.timerHours(undefined), null);
  });

  test('getTimerCommand resuelve por horas, incluido el 0 (cancelar)', async () => {
    assert.equal(await ir.getTimerCommand(97, 1.5), 'T15_97');
    assert.equal(await ir.getTimerCommand(97, 12), 'T120_97');
    assert.equal(await ir.getTimerCommand(97, 0), 'CANCEL97');
    assert.equal(await ir.getTimerCommand(97, 3), null, 'tiempo no aprendido');
    assert.equal(await ir.getTimerCommand(98, 0), null, 'code sin comando de cancelar');
  });

  test('getTimerHours devuelve los tiempos ordenados, sin el 0 de cancelar', async () => {
    assert.deepEqual(await ir.getTimerHours(97), [0.5, 1, 1.5, 12]);
    assert.deepEqual(await ir.getTimerHours(98), [1, 2, 8]);
    assert.deepEqual(await ir.getTimerHours(1), [], 'la planilla real todavía no tiene timer_off_*');
    assert.deepEqual(await ir.getTimerHours(999), []);
  });

  test('las filas timer_off_* no contaminan la autodetección de 2 pasos ni los modos', async () => {
    // `timer_off_10` es mode-only pero lleva '_': no debe leerse como un modo
    // de encendido separado (def. 13) ni aparecer en el resumen del wizard.
    assert.equal(await ir.hasModeOnlyRows(97), false);
    const s = await ir.getSummary(97);
    assert.deepEqual(s.modes.sort(), ['cool', 'off']);
    assert.deepEqual(s.timerHours, [0.5, 1, 1.5, 12]);
  });

  test('el script de learning del servidor usa exactamente las claves que arma timerKey', () => {
    // Contrato app ↔ servidor: los nombres `ir_ac1_timer_off_XX` que aprende
    // `ha-script-ac_timer_learn.yaml` tienen que coincidir con las claves de
    // planilla que después busca la app. Si alguien toca una punta sin la
    // otra, el código aprendido queda huérfano y el tile revierte.
    const yaml = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'referencia', 'ha-script-ac_timer_learn.yaml'), 'utf8',
    );
    const bloques = yaml.split(/^learn_ac1_timer_off/m).slice(1);
    assert.equal(bloques.length, 2, 'los dos scripts: rango completo y horas enteras');

    const claves = (texto) => [...texto.matchAll(/- ir_ac1_(timer_off_\d+)/g)].map((m) => m[1]);
    const medias = claves(bloques[0]);
    const horas = claves(bloques[1]);

    const esperadoMedias = ['timer_off_00'];
    for (let h = 0.5; h <= 12.0001; h += 0.5) esperadoMedias.push(IrCodes.timerKey(Math.round(h * 10) / 10));
    assert.deepEqual(medias, esperadoMedias, '0 (cancelar) + 0,5 a 12 h de 0,5 en 0,5');
    assert.equal(medias.length, 25);

    const esperadoHoras = ['timer_off_00'];
    for (let h = 1; h <= 12; h += 1) esperadoHoras.push(IrCodes.timerKey(h));
    assert.deepEqual(horas, esperadoHoras, '0 (cancelar) + 1 a 12 h enteras');

    // Y todas se leen de vuelta como horas válidas dentro del rango.
    for (const clave of [...medias, ...horas]) {
      const h = IrCodes.timerHours(clave);
      assert.ok(h != null && h >= 0 && h <= 12, `${clave} no es un tiempo válido`);
    }
  });

  test('getSummary describe el code para el wizard', async () => {
    const s = await ir.getSummary(1);
    assert.equal(s.commands, 166);
    assert.deepEqual(s.modes.sort(), ['auto', 'cool', 'heat', 'off']);
    assert.ok(s.fans.includes('turbo'));
    assert.equal(s.sleep, true);
    assert.equal(s.hasSwing, false);
    assert.deepEqual(s.tempRange, [16, 30]);
    assert.equal(s.twoStep, false);
    assert.equal(s.learnedFan, true);

    const s5 = await ir.getSummary(5);
    assert.equal(s5.twoStep, true);
    assert.equal(s5.learnedFan, false);

    assert.equal(await ir.getSummary(999), null);
  });

  test('getBrands degrada a [] si el Apps Script no soporta ?marcas=', async () => {
    // El mock devuelve '[]' para marcas → como el webservice real hoy.
    assert.deepEqual(await ir.getBrands(3), []);
  });

  test('falla de red: getters devuelven null (camino legacy), reload propaga el error', async () => {
    const failing = makeFetch({ failWith: new Error('ECONNREFUSED') });
    const irFail = makeService(failing);
    assert.equal(await irFail.getModeCommand(1, 'off'), null);
    await assert.rejects(() => irFail.reload(1), /ECONNREFUSED/);
  });

  test('respuesta corrupta no rompe: getter null', async () => {
    const bad = {
      fetchFn: async () => ({ ok: true, text: async () => '<html>login</html>' }),
    };
    const irBad = makeService(bad);
    assert.equal(await irBad.getModeCommand(1, 'off'), null);
  });
});
