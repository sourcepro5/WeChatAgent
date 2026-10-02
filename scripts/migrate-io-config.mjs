import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
};

export function migrateConnections(root) {
  const file = path.join(root, 'config', 'wechatagent.json');
  if (!fs.existsSync(file)) return;
  const config = read(file);
  const legacy = path.join(root, 'state', 'akasha-config.json');
  const destination = path.join(root, 'state', 'wechat-io-config.json');
  const old = fs.existsSync(legacy) ? read(legacy) : null;
  const current = fs.existsSync(destination) ? read(destination) : null;
  const oldPort = config.ports?.akasha;
  if (oldPort != null && config.ports.adapter != null && oldPort !== config.ports.adapter) throw new Error('Conflicting adapter ports; configuration was not migrated');
  if (old && current && ((old.access_token && current.reader_token && old.access_token !== current.reader_token) ||
      (old.bot_wxid && current.self_wxid && old.bot_wxid !== current.self_wxid))) throw new Error('Conflicting connection credentials; configuration was not migrated');
  if (!old && oldPort == null) return;
  const backup = path.join(root, 'state', 'migrations', 'connection-config-v1');
  fs.mkdirSync(backup, { recursive: true });
  if (!fs.existsSync(path.join(backup, 'wechatagent.json'))) fs.copyFileSync(file, path.join(backup, 'wechatagent.json'));
  if (old && !fs.existsSync(path.join(backup, 'legacy-connection.json'))) fs.copyFileSync(legacy, path.join(backup, 'legacy-connection.json'));
  if (old) write(destination, {
    reader_base_url: current?.reader_base_url ?? old.weflow_base_url,
    reader_token: current?.reader_token || old.access_token || '',
    self_wxid: current?.self_wxid || old.bot_wxid || '',
    onebot_ws_url: current?.onebot_ws_url ?? old.astrbot_ob_url,
  });
  if (oldPort != null) {
    config.ports.adapter = oldPort;
    delete config.ports.akasha;
    write(file, config);
  }
  if (old) fs.unlinkSync(legacy);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateConnections(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('Connection configuration migrated; credentials and chat settings preserved.');
}
