import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interestsListText } from '../../tgcloud/lib/render.js';
import { chunkMessage } from '../../tgcloud/lib/text.js';

// P2-9: список интересов длиннее лимита Telegram — раньше уходил одним сообщением
// и падал молча (пользователь не видел ничего). Режем тем же chunkMessage, что и сводку.
test('P2-9: длинный список интересов режется на сообщения ≤ 4000 с целыми тегами', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ term: `термин №${i} & тест`, total: i % 3, active: i % 2 }));
  const text = interestsListText(rows);
  assert.ok(text.length > 4000, `список длиннее лимита: ${text.length}`);
  const chunks = chunkMessage(text, 4000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000, `кусок ${chunk.length}`);
    for (const tag of ['b', 'i']) {
      const open = (chunk.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
      const close = (chunk.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `незакрытый <${tag}> в куске`);
    }
  }
  assert.ok(chunks.join('').includes('термин №119'), 'последний термин не потерялся');
});
