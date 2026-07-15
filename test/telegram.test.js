'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const TelegramNotifier = require('../lib/telegram');

function makeNotifier(config, { failPost = false } = {}) {
  const posts = [];
  const notifier = new TelegramNotifier({
    getChannelConfig: async () => config,
    fetchFn: async (url, opts) => {
      if (failPost) throw new Error('timeout');
      posts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, text: async () => '{}' };
    },
  });
  return { notifier, posts };
}

describe('TelegramNotifier', () => {
  test('envía al chat de soporte cuando está configurado', async () => {
    const { notifier, posts } = makeNotifier({
      token: 'TOK', chatId: '111', supportChatId: '222',
    });
    const sent = await notifier.notifyFailure('AC Living', 'HTTP 500');
    assert.equal(sent, true);
    assert.equal(posts[0].url, 'https://api.telegram.org/botTOK/sendMessage');
    assert.equal(posts[0].body.chat_id, '222');
    assert.match(posts[0].body.text, /AC Living/);
    assert.match(posts[0].body.text, /HTTP 500/);
  });

  test('sin chat de soporte cae al chat del cliente', async () => {
    const { notifier, posts } = makeNotifier({ token: 'TOK', chatId: '111' });
    assert.equal(await notifier.notifyFailure('AC', 'x'), true);
    assert.equal(posts[0].body.chat_id, '111');
  });

  test('sin configuración → false, sin POST y sin explotar', async () => {
    const { notifier, posts } = makeNotifier(null);
    assert.equal(await notifier.notifyFailure('AC', 'x'), false);
    assert.equal(posts.length, 0);
  });

  test('falla del POST → false, no lanza', async () => {
    const { notifier } = makeNotifier({ token: 'TOK', chatId: '1' }, { failPost: true });
    assert.equal(await notifier.notifyFailure('AC', 'x'), false);
  });
});
