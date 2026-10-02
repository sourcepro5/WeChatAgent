import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './project-config.mjs';

test('reader preserves sender, group ID, media and self-message boundaries', () => {
  const localConfig = path.join(projectRoot, 'config', 'wechatagent.json');
  const configFile = fs.existsSync(localConfig) ? localConfig : path.join(projectRoot, 'config', 'wechatagent.example.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  for (const script of ['test-reader.py', 'test-image-codec.py', 'test-sticker.py', '../components/weflow-cli/test/nt_decrypt_verify_test.py', 'test-vendored-reader.py']) {
    const result = spawnSync(process.env.WECHATAGENT_TEST_PYTHON || config.runtime.python, [path.join(projectRoot, 'scripts', script)], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  }
});
