import wa from './__sdk.mjs';

const select = document.querySelector('#chat'), list = document.querySelector('#notes'), status = document.querySelector('#status');
const say = (text, error = false) => { status.textContent = text; status.className = error ? 'error' : 'status'; };

function render(notes) {
  list.replaceChildren(...notes.map((note, index) => {
    const item = document.createElement('li'), text = document.createElement('span'), time = document.createElement('small'), remove = document.createElement('button');
    text.textContent = note.text;
    time.textContent = new Date(note.createdAt).toLocaleString();
    text.append(time);
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      try { render((await wa.actions.call('remove', { index }, { key: select.value })).notes ?? []); wa.ui.toast('便签已删除。'); }
      catch (error) { say(error.message, true); }
    });
    item.append(text, remove);
    return item;
  }));
  say(notes.length ? `共 ${notes.length} 条` : '这个聊天还没有便签。');
}

async function load() {
  if (!select.value) return;
  say('正在读取…');
  try { render((await wa.actions.call('list', {}, { key: select.value })).notes ?? []); }
  catch (error) { list.replaceChildren(); say(error.message, true); }
}

const info = await wa.info();
if (!info.enabled) say('插件尚未启用：点右上角“配置”允许运行并分配聊天。', true);
for (const chat of info.chats) select.append(new Option(chat.name, chat.key));
if (!info.chats.length && info.enabled) say('此插件还没有分配聊天。', true);
select.addEventListener('change', load);
document.querySelector('#refresh').addEventListener('click', load);
if (info.enabled) load();
