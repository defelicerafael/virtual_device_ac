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
// Sigue el formato exacto del webservice; swing de ambos tipos (def. 5 v3):
// on/off + posiciones, con una posición faltante (middle).
FIXTURES[99] = JSON.stringify([
  { code: 99, mode: 'off', fan: '', temp: '', sleep: '', irCommand: 'OFF99' },
  { code: 99, mode: 'cool', fan: 'auto', temp: 24, sleep: 'off', irCommand: 'COOL99' },
  { code: 99, mode: 'swing_on', fan: '', temp: '', sleep: '', irCommand: 'SWINGON99' },
  { code: 99, mode: 'swing_auto', fan: '', temp: '', sleep: '', irCommand: 'SWINGAUTO99' },
  { code: 99, mode: 'swing_up', fan: '', temp: '', sleep: '', irCommand: 'SWINGUP99' },
  { code: 99, mode: 'swing_down', fan: '', temp: '', sleep: '', irCommand: 'SWINGDOWN99' },
  { code: 99, mode: 'swing_off', fan: '', temp: '', sleep: '', irCommand: 'SWINGOFF99' },
  // Auto-apagado (def. 28): mismo patrón mode-only. 00 = cancelar.
  { code: 99, mode: 'timer_off_00', fan: '', temp: '', sleep: '', irCommand: 'TIMERCANCEL99' },
  { code: 99, mode: 'timer_off_05', fan: '', temp: '', sleep: '', irCommand: 'TIMER0599' },
  { code: 99, mode: 'timer_off_20', fan: '', temp: '', sleep: '', irCommand: 'TIMER2099' },
]);

const CONFIG_BASE = {
  host: '192.168.88.101',
  port: 8123,
  remoteEntity: 'escritorio',
  code: '',
  twoStepOverride: 'auto',
  learnedFanOverride: 'auto',
  allowSleep: true,
  allowFanSpeed: true,
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

  test('override learnedFan=yes con fan inexistente en planilla → cae a legacy con el fan pedido y reporta missing', async () => {
    const res = await h.sender.sendState(
      { ...CONFIG_BASE, code: 2, learnedFanOverride: 'yes' },
      { mode: 'cool', fan: 'high', temp: 24, sleep: 'off' },
      'fan',
    );
    const { payload } = h.posts[0];
    assert.equal(payload.command_code, undefined);
    assert.equal(payload.fan_mode, 'high');
    assert.deepEqual(res.missing, ['cool_high_24_off'], 'con code, la clave ausente se reporta (warning en tile)');
  });

  test('sin code, comando por legacy NO reporta missing (es el diseño, no un faltante)', async () => {
    const res = await h.sender.sendState(
      CONFIG_BASE,
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'temperature',
    );
    assert.deepEqual(res.missing, []);
  });

  test('con code y comando presente → missing vacío', async () => {
    const res = await h.sender.sendState(
      { ...CONFIG_BASE, code: 1 },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' },
      'temperature',
    );
    assert.deepEqual(res.missing, []);
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

  test('swing por clave → POST command_code correcto (posiciones y on/off)', async () => {
    const up = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, 'up');
    const off = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, 'off');
    const on = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, 'on');
    assert.equal(up.ok, true);
    assert.equal(off.ok, true);
    assert.equal(on.ok, true);
    assert.equal(h.posts[0].payload.command_code, 'SWINGUP99');
    assert.equal(h.posts[1].payload.command_code, 'SWINGOFF99');
    assert.equal(h.posts[2].payload.command_code, 'SWINGON99');
  });

  test('swing en posición sin código (middle) → skipped + missing, sin POST', async () => {
    const res = await h.sender.sendSwing({ ...CONFIG_BASE, code: 99 }, 'middle');
    assert.deepEqual(res, { ok: true, skipped: true, missing: ['swing_middle'] });
    assert.equal(h.posts.length, 0);
  });

  test('swing sin códigos (code 1 real) → skipped + missing, sin POST', async () => {
    const res = await h.sender.sendSwing({ ...CONFIG_BASE, code: 1 }, 'auto');
    assert.deepEqual(res, { ok: true, skipped: true, missing: ['swing_auto'] });
    assert.equal(h.posts.length, 0);
  });

  test('swing sin code configurado → skipped SIN missing', async () => {
    const res = await h.sender.sendSwing(CONFIG_BASE, 'auto');
    assert.deepEqual(res, { ok: true, skipped: true, missing: [] });
  });

  test('learning de swing → ac_learn como modo swing_<clave> con simple_mode', async () => {
    await h.sender.sendSwingLearn({ ...CONFIG_BASE, code: 99 }, 'middle');
    const { url, payload } = h.posts[0];
    assert.match(url, /ac_learn$/);
    assert.deepEqual(payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'swing_middle',
      simple_mode: true,
    });
  });

  test('def. 28: auto-apagado por horas → POST del command_code timer_off_XX', async () => {
    const media = await h.sender.sendTimer({ ...CONFIG_BASE, code: 99 }, 0.5);
    const dos = await h.sender.sendTimer({ ...CONFIG_BASE, code: 99 }, 2);
    const cancelar = await h.sender.sendTimer({ ...CONFIG_BASE, code: 99 }, 0);
    assert.equal(media.ok, true);
    assert.equal(dos.ok, true);
    assert.equal(cancelar.ok, true);
    assert.equal(h.posts[0].payload.command_code, 'TIMER0599');
    assert.equal(h.posts[1].payload.command_code, 'TIMER2099');
    assert.equal(h.posts[2].payload.command_code, 'TIMERCANCEL99');
    assert.equal(h.posts[0].payload.remote_entity, 'remote.escritorio');
  });

  test('def. 28: tiempo no aprendido → skipped + missing, sin POST ni fallback legacy', async () => {
    const res = await h.sender.sendTimer({ ...CONFIG_BASE, code: 99 }, 3);
    assert.deepEqual(res, { ok: true, skipped: true, missing: ['timer_off_30'] });
    assert.equal(h.posts.length, 0);
  });

  test('def. 28: sin code configurado → skipped SIN missing', async () => {
    const res = await h.sender.sendTimer(CONFIG_BASE, 2);
    assert.deepEqual(res, { ok: true, skipped: true, missing: [] });
    assert.equal(h.posts.length, 0);
  });

  test('def. 28: learning de un tiempo específico → ac_learn con timer_off_XX y simple_mode', async () => {
    await h.sender.sendTimerLearn({ ...CONFIG_BASE, code: 99, learnTimerScope: 'single' }, 1.5);
    const { url, payload } = h.posts[0];
    assert.match(url, /ac_learn$/);
    assert.deepEqual(payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'timer_off_15',
      simple_mode: true,
    });
  });

  test('def. 28: barrido 0,5–12 → hvac_mode timer_off SIN simple_mode (lo recorre el servidor)', async () => {
    // Sin `simple_mode` la automation del servidor cae al default y despacha
    // `script.learn_ac1_timer_off`, que hace UN learn_command con la lista
    // entera — igual que el 16–30 de temperaturas (def. 22).
    await h.sender.sendTimerLearn({ ...CONFIG_BASE, code: 99, learnTimerScope: 'range' }, 2);
    assert.deepEqual(h.posts[0].payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'timer_off',
    });
  });

  test('def. 28: barrido de horas enteras → hvac_mode timer_off_horas', async () => {
    await h.sender.sendTimerLearn({ ...CONFIG_BASE, code: 99, learnTimerScope: 'hour' }, 2);
    assert.equal(h.posts[0].payload.hvac_mode, 'timer_off_horas');
    assert.equal(h.posts[0].payload.simple_mode, undefined);
  });

  test('def. 28: sin alcance configurado el default es el barrido completo', async () => {
    await h.sender.sendTimerLearn({ ...CONFIG_BASE, code: 99 }, 2);
    assert.equal(h.posts[0].payload.hvac_mode, 'timer_off');
  });

  test('def. 21: sin permiso de sleep → sleep off en clave/payload aunque el tile diga on', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, code: 1, allowSleep: false },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'on' },
      'temperature',
    );
    // cool_auto_24_off existe en el code 1 → salió por planilla
    assert.ok(h.posts[0].payload.command_code);

    await h.sender.sendState(
      { ...CONFIG_BASE, allowSleep: false },
      { mode: 'cool', fan: 'auto', temp: 24, sleep: 'on' },
      'temperature',
    );
    assert.equal(h.posts[1].payload.sleep, 'off', 'legacy también fuerza off');
  });

  test('def. 21: sin permiso de velocidad → fan auto en payload y learning', async () => {
    await h.sender.sendState(
      { ...CONFIG_BASE, allowFanSpeed: false },
      { mode: 'cool', fan: 'turbo', temp: 24, sleep: 'off' },
      'fan',
    );
    assert.equal(h.posts[0].payload.fan_mode, 'auto');

    await h.sender.sendLearn(
      { ...CONFIG_BASE, allowFanSpeed: false, allowSleep: false },
      { mode: 'cool', fan: 'turbo', temp: 24, sleep: 'on' },
      'temperature',
    );
    assert.equal(h.posts[1].payload.fan_mode, 'auto');
    assert.equal(h.posts[1].payload.sleep, 'off');
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

  test('learning con trigger temperature → ac_learn SIN temperatura (def. 16, alcance rango)', async () => {
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

  test('learning con alcance "temperatura específica" → ac_learn CON la temp del tile (def. 22)', async () => {
    await h.sender.sendLearn(
      { ...CONFIG_BASE, learnTempScope: 'single' },
      { mode: 'cool', fan: 'auto', temp: 23, sleep: 'off' },
      'temperature',
    );
    assert.equal(h.posts[0].payload.temperature, 23);

    // El comando de encendido de 2 pasos NO lleva temperatura ni con 'single'.
    await h.sender.sendLearn(
      { ...CONFIG_BASE, code: 5, learnTempScope: 'single' },
      { mode: 'heat', fan: 'auto', temp: 23, sleep: 'off' },
      'mode',
    );
    assert.deepEqual(h.posts[1].payload, {
      remote_entity: 'remote.escritorio',
      device: 'ac1',
      hvac_mode: 'heat',
      simple_mode: true,
    });
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

// ---- Feedback del remote vía REST return_response (def. 26) ----
function makeTokenHarness({ serviceResponse = { ok: true }, failTimes = 0, reloadOk = true, serviceStatus = 200, stateStatus = 200 } = {}) {
  const posts = [];
  let failsLeft = failTimes;
  const fetchFn = async (url, opts) => {
    if (url.includes('/api/states/')) {
      // Pre-chequeo de existencia de la entidad (reloadBroadlink).
      if (failsLeft > 0) { failsLeft--; throw new Error('ECONNREFUSED'); }
      return { ok: stateStatus === 200, status: stateStatus, text: async () => '' };
    }
    if (opts && opts.method === 'POST') {
      if (failsLeft > 0) { failsLeft--; throw new Error('ECONNREFUSED'); }
      posts.push({ url, headers: opts.headers || {}, payload: JSON.parse(opts.body) });
      if (url.includes('/reload_config_entry')) {
        return { ok: reloadOk, status: reloadOk ? 200 : 500, text: async () => '' };
      }
      if (url.includes('?return_response')) {
        if (serviceStatus !== 200) return { ok: false, status: serviceStatus, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({ service_response: serviceResponse }) };
      }
      return { ok: true, text: async () => '' };
    }
    const match = /[?&]code=(\w+)$/.exec(url);
    return { ok: true, text: async () => (match && FIXTURES[match[1]]) || '[]' };
  };
  const irCodes = new IrCodes({ getBaseUrl: () => 'https://ws.example/exec?code=', fetchFn });
  const sender = new CommandSender({ irCodes, fetchFn, waitFn: async () => {} });
  return { sender, posts };
}

const CONFIG_TOKEN = { ...CONFIG_BASE, code: 1, haToken: 'TOK123' };

describe('CommandSender — feedback del remote (def. 26)', () => {
  test('con token: ac_command va por REST services con return_response y Bearer', async () => {
    const h = makeTokenHarness({ serviceResponse: { ok: true } });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, true);
    assert.equal(res.remoteDown, undefined);
    const { url, headers } = h.posts[0];
    assert.equal(url, 'http://192.168.88.101:8123/api/services/script/ac_command?return_response');
    assert.equal(headers.Authorization, 'Bearer TOK123');
  });

  test('con token y remote caído: ok:true + remoteDown (no revierte)', async () => {
    const h = makeTokenHarness({ serviceResponse: { ok: false, reason: 'remote_unavailable' } });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, true);
    assert.equal(res.remoteDown, true);
    assert.equal(res.reason, 'remote_unavailable');
  });

  test('remote_not_found se propaga como reason (mensaje específico en el device)', async () => {
    const h = makeTokenHarness({ serviceResponse: { ok: false, reason: 'remote_not_found' } });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.remoteDown, true);
    assert.equal(res.reason, 'remote_not_found');
  });

  test('remote caído NO se reintenta 3 veces (respuesta válida, no transitoria)', async () => {
    const h = makeTokenHarness({ serviceResponse: { ok: false, reason: 'remote_unavailable' } });
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(h.posts.length, 1);
  });

  test('sin token: sigue usando el webhook clásico (sin feedback)', async () => {
    const h = makeTokenHarness({ serviceResponse: { ok: false } });
    const res = await h.sender.sendState({ ...CONFIG_BASE, code: 1 }, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, true);
    assert.equal(res.remoteDown, undefined);
    assert.match(h.posts[0].url, /\/api\/webhook\/ac_command$/);
  });

  test('falla de transporte con token → ok:false + reason no_connection (red caída)', async () => {
    const h = makeTokenHarness({ failTimes: 99 });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_connection');
  });

  test('servicio inexistente (404) → reason service_missing', async () => {
    const h = makeTokenHarness({ serviceStatus: 404 });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'service_missing');
  });

  test('reloadBroadlink: POST a reload_config_entry con la entidad y Bearer', async () => {
    const h = makeTokenHarness({ reloadOk: true });
    const res = await h.sender.reloadBroadlink(CONFIG_TOKEN);
    assert.equal(res.ok, true);
    const post = h.posts.find((p) => p.url.includes('/reload_config_entry'));
    assert.equal(post.url, 'http://192.168.88.101:8123/api/services/homeassistant/reload_config_entry');
    assert.equal(post.payload.entity_id, 'remote.escritorio');
    assert.equal(post.headers.Authorization, 'Bearer TOK123');
  });

  test('reloadBroadlink sin token → ok:false + reason no_token', async () => {
    const h = makeTokenHarness();
    const res = await h.sender.reloadBroadlink({ ...CONFIG_BASE });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_token');
  });

  test('reloadBroadlink con entidad inexistente (404 en states) → remote_not_found', async () => {
    const h = makeTokenHarness({ stateStatus: 404 });
    const res = await h.sender.reloadBroadlink(CONFIG_TOKEN);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'remote_not_found');
    // No debe llegar a llamar al reload.
    assert.equal(h.posts.find((p) => p.url.includes('/reload_config_entry')), undefined);
  });

  test('reloadBroadlink sin conexión → no_connection', async () => {
    const h = makeTokenHarness({ failTimes: 99 });
    const res = await h.sender.reloadBroadlink(CONFIG_TOKEN);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_connection');
  });

  test('reloadBroadlink con reload fallido (500) → reload_failed', async () => {
    const h = makeTokenHarness({ reloadOk: false });
    const res = await h.sender.reloadBroadlink(CONFIG_TOKEN);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'reload_failed');
  });

  test('token rechazado (401) → fallback al webhook, NO revierte (def. 27)', async () => {
    const h = makeTokenHarness({ serviceStatus: 401 });
    const res = await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    assert.equal(res.ok, true, 'no rompe: cae al webhook');
    assert.equal(res.remoteDown, undefined);
    // Se intentó el REST y luego el webhook clásico.
    assert.ok(h.posts.some((p) => p.url.includes('?return_response')));
    assert.ok(h.posts.some((p) => p.url.endsWith('/api/webhook/ac_command')));
  });

  test('401 no se reintenta 3 veces (es config, no transitorio)', async () => {
    const h = makeTokenHarness({ serviceStatus: 401 });
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    const restPosts = h.posts.filter((p) => p.url.includes('?return_response'));
    assert.equal(restPosts.length, 1);
  });

  test('tras un 401, los siguientes comandos van directo al webhook (def. 27)', async () => {
    const h = makeTokenHarness({ serviceStatus: 401 });
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'heat', fan: 'auto', temp: 22, sleep: 'off' }, 'temperature');
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 20, sleep: 'off' }, 'temperature');
    const restPosts = h.posts.filter((p) => p.url.includes('?return_response'));
    assert.equal(restPosts.length, 1, 'solo el primer comando probó el REST');
    const webhookPosts = h.posts.filter((p) => p.url.endsWith('/api/webhook/ac_command'));
    assert.equal(webhookPosts.length, 3, 'los 3 comandos salieron por webhook');
  });

  test('resetTokenState reactiva el intento REST', async () => {
    const h = makeTokenHarness({ serviceStatus: 401 });
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'cool', fan: 'auto', temp: 24, sleep: 'off' }, 'temperature');
    h.sender.resetTokenState();
    await h.sender.sendState(CONFIG_TOKEN, { mode: 'heat', fan: 'auto', temp: 22, sleep: 'off' }, 'temperature');
    const restPosts = h.posts.filter((p) => p.url.includes('?return_response'));
    assert.equal(restPosts.length, 2, 'tras reset, vuelve a probar el REST');
  });
});
