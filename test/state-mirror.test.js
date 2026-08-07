'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { decide } = require('../lib/state-mirror');

describe('StateMirror.decide — escalera de inferencia (def. 29)', () => {

  test('descarga muy por encima del cuarto → calor, y es DECISIVO', () => {
    const r = decide({ dischargeTemp: 40, roomTemp: 20 });
    assert.deepEqual(r, { mode: 'heat', reason: 'discharge', decisive: true });
  });

  test('descarga muy por debajo del cuarto → frío, y es DECISIVO', () => {
    const r = decide({ dischargeTemp: 12, roomTemp: 26 });
    assert.deepEqual(r, { mode: 'cool', reason: 'discharge', decisive: true });
  });

  test('la descarga gana sobre los indicios aunque se contradigan', () => {
    // Afuera hace frío (diría calor) pero el equipo está tirando aire helado.
    const r = decide({
      dischargeTemp: 10, roomTemp: 24, outdoorTemp: 5, outdoorCutoff: 19, lastMode: 'heat',
    });
    assert.equal(r.mode, 'cool');
    assert.equal(r.reason, 'discharge');
  });

  test('descarga parecida al cuarto (arrancando o ventilando) no decide: baja a los indicios', () => {
    const r = decide({ dischargeTemp: 21, roomTemp: 20, outdoorTemp: 30, outdoorCutoff: 19 });
    assert.equal(r.reason, 'outdoor');
    assert.equal(r.mode, 'cool');
  });

  test('el cuarto sube desde que arrancó → calor (indicio, no decisivo)', () => {
    const r = decide({ roomTemp: 22.5, roomTempAtStart: 20 });
    assert.deepEqual(r, { mode: 'heat', reason: 'room_trend', decisive: false });
  });

  test('el cuarto baja desde que arrancó → frío (indicio)', () => {
    const r = decide({ roomTemp: 23, roomTempAtStart: 26 });
    assert.deepEqual(r, { mode: 'cool', reason: 'room_trend', decisive: false });
  });

  test('la tendencia del cuarto gana sobre la temperatura de afuera', () => {
    // Verano afuera, pero el cuarto se está calentando: el equipo está en calor.
    const r = decide({
      roomTemp: 24, roomTempAtStart: 21, outdoorTemp: 33, outdoorCutoff: 19,
    });
    assert.equal(r.mode, 'heat');
    assert.equal(r.reason, 'room_trend');
  });

  test('el cuarto casi no se movió: no alcanza, sigue bajando la escalera', () => {
    const r = decide({
      roomTemp: 20.2, roomTempAtStart: 20, outdoorTemp: 4, outdoorCutoff: 19,
    });
    assert.equal(r.reason, 'outdoor');
    assert.equal(r.mode, 'heat');
  });

  test('solo contacto + temperatura de afuera: es el caso de la flota de hoy', () => {
    assert.equal(decide({ outdoorTemp: 30, outdoorCutoff: 19 }).mode, 'cool');
    assert.equal(decide({ outdoorTemp: 8, outdoorCutoff: 19 }).mode, 'heat');
  });

  test('afuera dentro de la banda muerta → no se asume nada, cae a lastMode', () => {
    const r = decide({ outdoorTemp: 20, outdoorCutoff: 19, lastMode: 'heat' });
    assert.deepEqual(r, { mode: 'heat', reason: 'last_mode', decisive: false });
    // 19±3 → la zona de nadie es ABIERTA: (16, 22). Los bordes exactos sí deciden.
    assert.equal(decide({ outdoorTemp: 21.9, outdoorCutoff: 19 }).reason, 'undetermined');
    assert.equal(decide({ outdoorTemp: 16.1, outdoorCutoff: 19 }).reason, 'undetermined');
    assert.equal(decide({ outdoorTemp: 22, outdoorCutoff: 19 }).mode, 'cool');
    assert.equal(decide({ outdoorTemp: 16, outdoorCutoff: 19 }).mode, 'heat');
  });

  test('el corte de afuera es configurable por equipo', () => {
    // Con corte 25, 24° todavía no alcanza para decir "frío".
    assert.equal(decide({ outdoorTemp: 24, outdoorCutoff: 25 }).reason, 'undetermined');
    assert.equal(decide({ outdoorTemp: 29, outdoorCutoff: 25 }).mode, 'cool');
  });

  test('sin ninguna evidencia → mode null: el tile no se toca', () => {
    assert.deepEqual(decide(), { mode: null, reason: 'undetermined', decisive: false });
    assert.equal(decide({ lastMode: 'off' }).mode, null, 'lastMode "off" no sirve de modo');
  });

  test('valores basura se ignoran como si no estuvieran', () => {
    assert.equal(decide({ dischargeTemp: null, roomTemp: 20 }).reason, 'undetermined');
    assert.equal(decide({ dischargeTemp: NaN, roomTemp: 20, outdoorTemp: 31 }).mode, 'cool');
    assert.equal(decide({ outdoorTemp: 'treinta', lastMode: 'cool' }).reason, 'last_mode');
  });

  test('NINGÚN indicio es decisivo — solo la descarga puede pisar un modo conocido', () => {
    // Regla de seguridad de la def. 29: el device solo aplica un resultado no
    // decisivo cuando el tile estaba apagado. Si esto se rompe, prender en
    // `cool` desde Homey en invierno haría que la app te cambie el tile sola.
    for (const entrada of [
      { roomTemp: 24, roomTempAtStart: 20 },
      { outdoorTemp: 35, outdoorCutoff: 19 },
      { lastMode: 'cool' },
    ]) {
      assert.equal(decide(entrada).decisive, false, JSON.stringify(entrada));
    }
    assert.equal(decide({ dischargeTemp: 40, roomTemp: 20 }).decisive, true);
  });

});
