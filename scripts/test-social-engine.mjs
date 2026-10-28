import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSocialPrompt } from '../components/qq-bridge/src/core/social-engine.js';

const rows = [
  { timestamp: 100, sender_name: 'A', text: '在吗' },
  { timestamp: 101, sender_name: 'B', text: '出来' },
];

test('direct multi-speaker batch adds a two-part hint', () => {
  const prompt = buildSocialPrompt({ key: 'wechat:group:1', rows, direct: true, lastReplyAt: null });
  assert.match(prompt, /多人同时说话/);
  assert.match(prompt, /分成两段/);
});

test('ordinary batch does not add the multi-speaker hint', () => {
  const prompt = buildSocialPrompt({ key: 'wechat:group:1', rows, direct: false, lastReplyAt: null });
  assert.doesNotMatch(prompt, /多人同时说话/);
});
