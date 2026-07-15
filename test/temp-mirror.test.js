'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const TempMirror = require('../lib/temp-mirror');

function makeFakeSource(name, initial) {
  const source = {
    name,
    capabilities: ['measure_temperature'],
    capabilitiesObj: { measure_temperature: { value: initial } },
    _callback: null,
    _destroyed: false,
    makeCapabilityInstance(capability, callback) {
      source._callback = callback;
      return { destroy: () => { source._destroyed = true; } };
    },
    emit(value) { source._callback?.(value); },
  };
  return source;
}

function makeFakeAc(id) {
  const ac = {
    values: [],
    getData: () => ({ id }),
    getName: () => `AC ${id}`,
    setCapabilityValue: async (capability, value) => { ac.values.push([capability, value]); },
  };
  return ac;
}

function makeMirror(sources) {
  return new TempMirror({
    getHomeyApi: async () => ({
      devices: {
        getDevices: async () => Object.fromEntries(sources.map((s, i) => [`id${i}`, s])),
      },
    }),
  });
}

describe('TempMirror', () => {
  test('attach siembra el valor inicial y espeja los cambios', async () => {
    const source = makeFakeSource('Sensor Living', 22.5);
    const ac = makeFakeAc('ac1');
    const mirror = makeMirror([source]);

    assert.equal(await mirror.attach(ac, 'Sensor Living'), true);
    assert.deepEqual(ac.values, [['measure_temperature', 22.5]]);

    source.emit(23);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ac.values.at(-1), ['measure_temperature', 23]);
  });

  test('fuente inexistente o sin capability → attach false', async () => {
    const noTemp = { name: 'Lampara', capabilities: ['onoff'] };
    const mirror = makeMirror([noTemp]);
    const ac = makeFakeAc('ac1');
    assert.equal(await mirror.attach(ac, 'Lampara'), false);
    assert.equal(await mirror.attach(ac, 'NoExiste'), false);
    assert.equal(await mirror.findSourceByName('Lampara'), null);
  });

  test('re-attach destruye la suscripción anterior; detach corta el espejo', async () => {
    const a = makeFakeSource('Sensor A', 20);
    const b = makeFakeSource('Sensor B', 25);
    const ac = makeFakeAc('ac1');
    const mirror = makeMirror([a, b]);

    await mirror.attach(ac, 'Sensor A');
    await mirror.attach(ac, 'Sensor B');
    assert.equal(a._destroyed, true, 'la primera suscripción se destruyó');

    mirror.detach(ac);
    assert.equal(b._destroyed, true);
  });

  test('HomeyAPI caída → attach false sin lanzar', async () => {
    const mirror = new TempMirror({ getHomeyApi: async () => { throw new Error('offline'); } });
    assert.equal(await mirror.attach(makeFakeAc('x'), 'Sensor'), false);
  });
});
