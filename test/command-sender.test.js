'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IrCodes = require('../lib/ir-codes');
const CommandSender = require('../lib/command-sender');

const FIXTURES = {};
for (const code of [1, 2, 5]) {
  FIXTURES[code] = fs.readFileSync(path.join(__dirname, 'fixtures', `code${code}.json`), 'utf8');
}
// Fixture sintético: la planilla real todavía no tiene filas swing_* (docs/planilla-ir.md).
// Sigue el formato exacto del webservice; swing con códigos DISTINTOS (def. 5).
FIXTURES[99] = JSON.stringify([
  { code: 99, mode: 'off', fan: '', temp: '', sleep: '', irCommand: 'OFF99' },
  { code: 99, mode: 'cool', fan: 'auto', temp: 24, sleep: 'off', irCommand: 'COOL99' },
  { code: 99, mode: 'swing_on', fan: '', temp: '', sleep: '', irCommand: 'SWINGON99' },
  { code: 99, mode: 'swing_off', fan: '', temp: '', sleep: '', irCommand: 'SWINGOFF99' },
]);

const CONFIG_BASE = {
  host: '192.168.88.101',
  port: 8123,
  remoteEntity: 'escritorio',
  code: '',
  twoStepOverride: 'auto',
  learnedFanOverride: 'auto',
};

function makeHarness({ failTimes = 0 } = {}) {
  const posts = [];
  const gets = [];
  const waits = [];
  let failsLeft = failTimes;

  const fetchFn = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      if (failsLeft > 0) {
        failsLeft--;
        throw new Error('ECONNREFUSED');
      }
      posts.push({ url, payload: JSON.parse(opts.body) });
      return { ok: true, text: async () => '' };
    }
    gets.push(url);
    const match = /[?&]code=(\w+)$/.exec(url);
    return { ok: true, text: async () => (match && FIXTURES[match[1]]) || '[]' };
  };

  const irCodes = new IrCodes({ getBaseUrl: () => 'https://ws.example/exec?code=', fetchFn });
  const sender = new CommandSender({
    irCodes,
    fetchFn,
    waitFn: async (ms) => { waits.push(ms); },
  });
  return { sender, posts, gets, waits };
}

describe('CommandSender', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });

  test('con code y comando en planilla → POST único con command_code', async () => {
    const res = await h.sender.sendState(
      { ...CONFIG_BASE, code: 1 },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'temperature',
    );
    assert.equal(res.ok, true);
    assert.equal(h.posts.length, 1);
    const { url, payload } = h.posts[0];
    assert.equal(url, 'http://192.168.88.101:8123/api/webhook/ac_command');
    assert.equal(payload.remote_entity, 'remote.escritorio');
    assert.ok(payload.command_code.startsWith('Jg'));
    assert.equal(payload.device, undefined, 'command_code no lleva campos legacy');
  });

  test('sin code → payload legacy completo (def. 13)', async () => {
    await h.sender.sendState(
      CONFIG_BASE,
      { mode: 'cool', fan: 'high', temp: 22, sleep: 'on' },
      'temperature',
    );
    assert.deepEqual(h.posts[0].payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'cool',
      fan_mode: 'high', // sin code, 'auto' = enviar lo elegido
      sleep: 'on',
      temperature: 22,
    });
    assert.equal(h.gets.length, 0, 'sin code no consulta la planilla');
  });

  test('fan no aprendido (autodetección, code 2) → se envía auto y encuentra el código', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 2 },
      { mode: 'cool', fan: 'high', temp: 24, sleep: 'off' },
      'fan',
    );
    // code 2 solo tiene fan auto: el fan pedido (high) se degrada a auto → hay command_code
    assert.ok(h.posts[0].payload.command_code);
  });

  test('override learnedFan=yes con fan inexistente en planilla → cae a legacy con el fan pedido', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 2, learnedFanOverride: 'yes' },
      { mode: 'cool', fan: 'high', temp: 24, sleep: 'off' },
      'fan',
    );
    const { payload } = h.posts[0];
    assert.equal(payload.command_code, undefined);
    assert.equal(payload.fan_mode, 'high');
  });

  test('apagado → comando off de la planilla', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 1 },
      { mode: 'off', fan: 'auto', temp: 24, sleep: 'off' },
      'mode',
    );
    assert.ok(h.posts[0].payload.command_code, 'usa la fila off');
  });

  test('encendido en 2 pasos autodetectado (code 5) con trigger mode → modo, wait 2s, completo', async () => {
    const res = await h.sender.sendState(
      { ...CONFIG_BASE, code: 5 },
      { mode: 'heat', fan: 'auto', temp: 20, sleep: 'off' },
      'mode',
    );
    assert.equal(res.ok, true);
    assert.equal(h.posts.length, 2);
    assert.ok(h.posts[0].payload.command_code, 'paso 1: comando de modo de la planilla');
    assert.ok(h.waits.includes(2000), 'espera 2s entre pasos');
    assert.ok(h.posts[1].payload.command_code, 'paso 2: comando completo');
  });

  test('code 5 con trigger temperature → NO hace 2 pasos', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 5 },
      { mode: 'heat', fan: 'auto', temp: 21, sleep: 'off' },
      'temperature',
    );
    assert.equal(h.posts.length, 1);
  });

  test('sin code + override twoStep=yes + trigger mode → simple_mode legacy, wait, completo legacy', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, twoStepOverride: 'yes' },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'mode',
    );
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[0].payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'cool',
      simple_mode: true,
    });
    assert.equal(h.posts[1].payload.temperature, 24);
  });

  test('override twoStep=no pisa la autodetección (code 5)', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 5, twoStepOverride: 'no' },
      { mode: 'heat', fan: 'auto', temp: 20, sleep: 'off' },
      'mode',
    );
    assert.equal(h.posts.length, 1);
  });

  test('reintentos: 2 fallas y éxito al tercer intento', async () => {
    const hf = makeHarness({ failTimes: 2 });
    const res = await hf.sender.sendState(
      CONFIG_BASE,
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'temperature',
    );
    assert.equal(res.ok, true);
    assert.equal(hf.posts.length, 1);
    assert.deepEqual(hf.waits, [500, 1000], 'backoff creciente');
  });

  test('falla definitiva → ok:false con error; en 2 pasos no envía el paso 2', async () => {
    const hf = makeHarness({ failTimes: 99 });
    const res = await hf.sender.sendState(
      { ...CONFIG_BASE, code: 5 },
      { mode: 'heat', fan: 'auto', temp: 20, sleep: 'off' },
      'mode',
    );
    assert.equal(res.ok, false);
    assert.match(res.error.message, /ECONNREFUSED/);
    assert.equal(hf.posts.length, 0);
    assert.ok(!hf.waits.includes(2000), 'no llegó al wait del paso 2');
  });

  test('swing con códigos en planilla → POST command_code correcto', async () => {
    const on = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, true);
    const off = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, false);
    assert.equal(on.ok, true);
    assert.equal(off.ok, true);
    assert.equal(h.posts[0].payload.command_code, 'SWINGON99');
    assert.equal(h.posts[1].payload.command_code, 'SWINGOFF99');
  });

  test('swing sin códigos (code 1 real) → skipped, sin POST', async () => {
    const res = await h.sender.sendSwing({ ...CONFIG_BASE, code: 1 }, true);
    assert.deepEqual(res, { ok: true, skipped: true });
    assert.equal(h.posts.length, 0);
  });

  test('learning 2 pasos + trigger mode → ac_learn con simple_mode (def. 16)', async () => {
    await h.sender.sendLearn(
      { ...CONFIG_BASE, code: 5 },
      { mode: 'heat', fan: 'auto', temp: 20, sleep: 'off' },
      'mode',
    );
    const { url, payload } = h.posts[0];
    assert.match(url, /ac_learn$/);
    assert.deepEqual(payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'heat',
      simple_mode: true,
    });
  });

  test('learning con trigger temperature → ac_learn SIN temperatura (def. 16)', async () => {
    await h.sender.sendLearn(
      { ...CONFIG_BASE, code: 5 },
      { mode: 'heat', fan: 'auto', temp: 20, sleep: 'off' },
      'temperature',
    );
    const { url, payload } = h.posts[0];
    assert.match(url, /ac_learn$/);
    assert.equal(payload.temperature, undefined, 'el servidor recorre 16-30 solo');
    assert.equal(payload.hvac_mode, 'heat');
    assert.equal(payload.simple_mode, undefined);
  });

  test('remote_entity acepta con y sin prefijo remote.', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, remoteEntity: 'remote.living' },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'temperature',
    );
    assert.equal(h.posts[0].payload.remote_entity, 'remote.living');
  });
});
