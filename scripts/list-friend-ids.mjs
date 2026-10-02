import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
const weflow = read('state/weflow/WeFlow-config.json');
const project = read('config/wechatagent.json');
const io = read('state/wechat-io-config.json');
const keyword = process.argv.slice(2).join(' ').trim();
const show = (wxid, name) => {
  const id = (crypto.createHash('sha256').update(String(wxid)).digest().readBigUInt64BE(0) % 2147483647n + 1n).toString();
  console.log(JSON.stringify({ name, onebotId: id, alreadyAllowed: project.wechat.whitelist.private.map(String).includes(id) }));
};
if (keyword) {
  try {
    const response = await fetch(`${io.reader_base_url}/api/v1/contacts?keyword=${encodeURIComponent(keyword)}&limit=100`, {
      headers: { Authorization: 'Bearer ' + io.reader_token }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Contact query unavailable');
    const data = await response.json();
    if (data.success === false || !Array.isArray(data.contacts)) throw new Error('Invalid contact response');
    const contacts = data.contacts.filter(contact => contact.username && !String(contact.username).includes('@chatroom') && contact.username !== io.self_wxid);
    for (const contact of contacts) show(contact.username, contact.remark || contact.displayName || contact.nickname || 'Unnamed contact');
    if (!contacts.length) console.log('未找到匹配好友。请检查昵称或备注，确认电脑微信已同步联系人；新加好友后可先重启 WeChatAgent 再查询。');
  } catch {
    console.error('无法查询联系人。请先登录电脑微信并启动 WeChatAgent，再运行好友查询。');
    process.exitCode = 1;
  }
} else {
for (const wxid of weflow.messagePushFilterList ?? []) {
  if (String(wxid).includes('@chatroom')) continue;
  let name = 'Name unavailable (open the WeFlow database to resolve it)';
  try {
    const response = await fetch(`${io.reader_base_url}/api/v1/contacts?keyword=${encodeURIComponent(wxid)}&limit=5`, { headers: { Authorization: 'Bearer ' + io.reader_token }, signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const data = await response.json();
      const match = data.contacts?.find(contact => contact.username === wxid);
      if (match) name = match.remark || match.displayName || match.nickname || 'Unnamed contact';
    }
  } catch {}
  show(wxid, name);
}
}
