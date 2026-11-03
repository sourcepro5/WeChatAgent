import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TIME_ZONE, timeZoneOf, validateTimeZone} from '../packages/dsh-social-bridge-plugin/time-zone-policy.mjs';
import {TIME_ZONE_PRESETS} from '../public/console/time-zone-presets.mjs';
import {buildPrivatePrompt, buildSocialPrompt} from '../components/qq-bridge/src/core/social-engine.js';

const row = (value) => ({ id: 'row-' + Math.random(), role: 'user', sender_name: '群友', ...value });

test('time_zone defaults to Beijing and accepts IANA names', () => {
  assert.equal(timeZoneOf({}), DEFAULT_TIME_ZONE);
  assert.equal(timeZoneOf({ time_zone: '' }), DEFAULT_TIME_ZONE);
  assert.equal(timeZoneOf({ time_zone: 'Australia/Sydney' }), 'Australia/Sydney');
  assert.equal(timeZoneOf({ time_zone: 'Mars/Olympus' }), DEFAULT_TIME_ZONE);
  validateTimeZone(undefined);
  validateTimeZone('');
  validateTimeZone('UTC');
  for (const bad of ['Mars/Olympus', 'beijing', 'Asia/Nowhere']) assert.throws(() => validateTimeZone(bad), /Invalid time_zone/);
  for (const bad of [1, true, {}, []]) assert.throws(() => validateTimeZone(bad), /Invalid time_zone/);
});

test('prompt clock follows wechat.time_zone and falls back to Beijing', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0);
  const rows = [row({ timestamp: now / 1000, text: '现在几点' })];
  const sydney = buildPrivatePrompt({ key: 'wechat:private:123', rows, now, timeZone: 'Australia/Sydney' });
  assert(sydney.includes('Australia/Sydney'));
  assert(sydney.includes('11:00'));
  const shanghai = buildPrivatePrompt({ key: 'wechat:private:123', rows, now });
  assert(shanghai.includes('北京时间，Asia/Shanghai'));
  assert(shanghai.includes('08:00'));
  const broken = buildPrivatePrompt({ key: 'wechat:private:123', rows, now, timeZone: 'Mars/Olympus' });
  assert(broken.includes('北京时间，Asia/Shanghai'));
  const group = buildSocialPrompt({ key: 'wechat:group:1', rows, direct: true, now, timeZone: 'UTC' });
  assert(group.includes('（UTC）'));
  assert(group.includes('00:00'));
});

test('every preset offered in the console is a valid time zone', () => {
  for (const [zone] of TIME_ZONE_PRESETS) validateTimeZone(zone);
  assert(TIME_ZONE_PRESETS.every(([zone]) => typeof zone === 'string'));
  assert.equal(new Set(TIME_ZONE_PRESETS.map(([zone]) => zone)).size, TIME_ZONE_PRESETS.length);
});
