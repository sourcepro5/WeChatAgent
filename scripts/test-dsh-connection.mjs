import test from 'node:test';
import assert from 'node:assert/strict';
import { DshConnectionGuard } from '../components/qq-bridge/src/core/dsh-connection.js';

function makeBuffer() {
  return {
    dshConnection: null,
    skipOfflineInputs() { return 0; },
    saveMedia() {},
  };
}

test('tolerates one or two transient health failures without changing epoch', async () => {
  let healthy = true;
  const guard = new DshConnectionGuard({
    buffer: makeBuffer(),
    probe: async () => ({ ready: healthy, instanceId: 'instance-a' }),
  });

  assert.equal(await guard.check({ force: true }), true);
  const epoch = guard.epoch;

  healthy = false;
  assert.equal(await guard.check({ force: true }), true);
  assert.equal(guard.epoch, epoch);

  assert.equal(await guard.check({ force: true }), true);
  assert.equal(guard.epoch, epoch);

  assert.equal(await guard.check({ force: true }), false);
  assert.equal(guard.epoch, epoch + 1);
});

test('recovers on the next healthy probe', async () => {
  let healthy = false;
  const guard = new DshConnectionGuard({
    buffer: makeBuffer(),
    probe: async () => ({ ready: healthy, instanceId: 'instance-a' }),
  });

  assert.equal(await guard.check({ force: true }), false);
  healthy = true;
  assert.equal(await guard.check({ force: true }), true);
  assert.equal(guard.failures, 0);
});
