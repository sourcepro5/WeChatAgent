import wa from './__sdk.mjs';

const PAGE = 12;
const $ = selector => document.querySelector(selector);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
let info = {}, offset = 0, total = 0, sequence = 0, writing = false;

function notice(text, error = false) {
  $('#notice').hidden = !text;
  $('#notice').textContent = text;
  $('#notice').className = error ? 'notice error' : 'notice';
}

function paper(entry) {
  const written = new Date(entry.createdAt).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false});
  return el('article', {className: 'paper'},
    el('header', {}, el('time', {textContent: entry.date}), el('h2', {textContent: entry.personaName + '的小本本'}), el('p', {textContent: `写于 ${written} · ${entry.sourceCount} 条当天聊天片段`})),
    el('div', {className: 'prose', textContent: entry.text}),
    el('footer', {textContent: '以人格视角记录的心情与联想，事件依据有限聊天记录。'}));
}

function empty(text) {
  return el('section', {className: 'paper empty'}, el('span', {className: 'date', textContent: '今天这一页'}), el('h2', {textContent: '这页还空着'}), el('p', {textContent: text}));
}

function controls() {
  const ready = info.enabled && !!$('#chat').value;
  $('#write').disabled = !ready || writing;
  $('#refresh').disabled = !ready;
}

async function load() {
  const own = ++sequence, key = $('#chat').value;
  controls();
  if (!info.enabled) {
    $('#entries').replaceChildren(empty('插件尚未启用。点右上角“配置”允许运行、勾选所需能力并分配聊天；已有日记会保留，启用后在这里查看。'));
    $('#paging').hidden = true;
    return;
  }
  if (!key) {
    $('#entries').replaceChildren(empty('此插件还没有分配聊天。在“配置”中选择要写日记的聊天。'));
    $('#paging').hidden = true;
    return;
  }
  notice('');
  try {
    const page = await wa.actions.call('list', {offset}, {key});
    if (own !== sequence) return;
    total = page.total;
    $('#entries').replaceChildren(...(page.entries.length ? page.entries.map(paper) : [empty('有聊天记录的日子会在晚间写下。也可以在微信问起，或点击“写下今天”。')]));
    if (page.errors) notice('部分日记暂时无法读取，原文件已保留。', true);
    $('#paging').hidden = total <= PAGE;
    $('#page-label').textContent = `${total} 篇日记 · 第 ${Math.floor(offset / PAGE) + 1} 页`;
    $('#prev').disabled = offset === 0;
    $('#next').disabled = offset + PAGE >= total;
  } catch (error) {
    if (own !== sequence) return;
    $('#entries').replaceChildren();
    $('#paging').hidden = true;
    notice(error.message, true);
  }
}

async function writeToday() {
  if (writing) return;
  writing = true;
  controls();
  $('#write').textContent = '正在写下今天…';
  try {
    await wa.actions.call('write-today', {}, {key: $('#chat').value});
    wa.ui.toast('今天的日记已保存');
    offset = 0;
    await load();
  } catch (error) {
    notice('日记暂未写成：' + error.message, true);
  } finally {
    writing = false;
    $('#write').textContent = '写下今天';
    controls();
  }
}

try {
  const [host, current] = await Promise.all([wa.info(), wa.settings.get()]);
  info = host;
  $('#write-time').textContent = current.values.writeTime ?? '21:30';
  $('#summary').textContent = info.enabled ? '插件已开启，按已分配的聊天生效。' : '插件当前关闭，已有日记仍然保留。';
  for (const chat of info.chats) $('#chat').append(new Option(chat.name, chat.key));
  $('#chat').disabled = !info.chats.length;
  if (!info.chats.length) $('#chat').append(new Option('尚无分配的聊天', ''));
  $('#chat').addEventListener('change', () => { offset = 0; void load(); });
  $('#refresh').addEventListener('click', () => void load());
  $('#write').addEventListener('click', () => void writeToday());
  $('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); void load(); });
  $('#next').addEventListener('click', () => { offset += PAGE; void load(); });
  await load();
} catch (error) {
  notice(error.message, true);
}
