import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateConnections } from './migrate-io-config.mjs';
import { prepare, projectRoot } from './project-config.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent migration '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['config','roles','state/weflow']) fs.mkdirSync(path.join(root,directory), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.example.json'),'utf8'));
  config.ports.akasha = config.ports.adapter; delete config.ports.adapter;
  config.wechat.whitelist.private = ['123']; config.wechat.whitelist.groups = ['456'];
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,`roles/${config.persona.default}.md`),'Fixture persona');
  fs.writeFileSync(path.join(root,'state/akasha-config.json'),JSON.stringify({ access_token:'fixture-reader-token', bot_wxid:'wxid_fixture_self', weflow_base_url:'http://127.0.0.1:5031', astrbot_ob_url:'ws://127.0.0.1:11229/ws' }));
  fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'fixture-dsh-token');
  fs.writeFileSync(path.join(root,'state/weflow/WeFlow-config.json'),'fixture protected database configuration');
  fs.writeFileSync(path.join(root,'state/social-messages.json'),JSON.stringify({ chats: { 'wechat:private:123':[{ text:'fixture',processed:false }] } }));
  return {root,config};
}

test('connection migration preserves credentials, whitelists, personas and buffered messages', t => {
  const {root,config}=fixture(t);
  const buffer = fs.readFileSync(path.join(root,'state/social-messages.json'),'utf8');
  prepare(root);
  const migrated = JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'));
  assert.equal(migrated.ports.adapter,8766); assert.equal(migrated.ports.akasha,undefined);
  assert.deepEqual(migrated.wechat,config.wechat); assert.deepEqual(migrated.persona,config.persona);
  const connection=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8'));
  assert.equal(connection.reader_token,'fixture-reader-token'); assert.equal(connection.self_wxid,'wxid_fixture_self');
  assert.equal(fs.readFileSync(path.join(root,'state/social-dsh-token.txt'),'utf8'),'fixture-dsh-token');
  assert.equal(fs.readFileSync(path.join(root,'state/social-messages.json'),'utf8'),buffer);
  assert.equal(fs.readFileSync(path.join(root,'state/weflow/WeFlow-config.json'),'utf8'),'fixture protected database configuration');
  assert.equal(fs.existsSync(path.join(root,'state/akasha-config.json')),false);
  prepare(root); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8')),connection);
});

test('conflicting new credentials stop migration without overwriting either configuration', t => {
  const {root}=fixture(t);
  const canonical=path.join(root,'state/wechat-io-config.json');
  fs.writeFileSync(canonical,JSON.stringify({ reader_token:'different-fixture-token',self_wxid:'wxid_fixture_self' }));
  const previous=fs.readFileSync(canonical,'utf8'), config=fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8');
  assert.throws(()=>migrateConnections(root),/Conflicting connection credentials/);
  assert.equal(fs.readFileSync(canonical,'utf8'),previous);
  assert.equal(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8'),config);
  assert.equal(fs.existsSync(path.join(root,'state/akasha-config.json')),true);
});
