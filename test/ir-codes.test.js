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
