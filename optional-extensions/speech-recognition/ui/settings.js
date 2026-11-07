import wa from './__sdk.mjs';

// Layout and wording for the package's own settings page. Field types and
// limits still come from plugin.json's configSchema via wa.settings.get().
const CONNECTION = ['apiProtocol', 'endpoint', 'apiKey'];
const ADVANCED = ['authHeader', 'authPrefix', 'headersJson', 'requestMode', 'language', 'audioFormat', 'fileField', 'modelField', 'languageField', 'extraFieldsJson', 'jsonTemplate', 'responseMode', 'responsePath', 'timeoutMs', 'maxDurationSeconds', 'maxTranscriptChars', 'cacheResults', 'modelsEndpoint', 'modelsResponsePath', 'autoReadModels'];
const OPTIONS = {
  apiProtocol: {
    label: '服务类型',
    help: 'auto 默认文件转写；完整 /chat/completions 地址使用 Chat 音频。模型 ID 原样传递，不按名字切换协议。',
    enumLabels: ['自动识别地址（默认文件转写）', '文件转写（OpenAI 兼容）', 'Chat 音频（Base64）', 'Chat 音频（Data URL 扩展）', 'Anthropic 模型目录（不转写音频）', '自定义请求'],
  },
};
const LONG_TEXT = new Set(['jsonTemplate', 'extraFieldsJson']);
const REQUEST_FIELDS = new Set(['apiProtocol', 'requestMode', 'audioFormat', 'fileField', 'modelField', 'languageField', 'extraFieldsJson', 'jsonTemplate', 'responseMode', 'responsePath']);
const CONNECTION_FIELDS = new Set(['apiProtocol', 'requestMode', 'endpoint', 'apiKey', 'authHeader', 'authPrefix', 'headersJson', 'modelsEndpoint', 'modelsResponsePath', 'autoReadModels']);
const STATES = new Set(['ok', 'error', 'warning', 'pending']);
const $ = selector => document.querySelector(selector);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const time = value => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});

let schema = {}, info = {}, sequence = 0, timer, dirty = false;
const inputs = new Map();

function control(key) {
  const spec = schema[key], ui = OPTIONS[key] ?? {}, id = 'field-' + key;
  let input;
  if (spec.type === 'boolean') input = el('input', {type: 'checkbox', id});
  else if (spec.enum) input = el('select', {id}, ...spec.enum.map((value, index) => el('option', {value, textContent: ui.enumLabels?.[index] ?? value})));
  else if (LONG_TEXT.has(key)) input = el('textarea', {id, rows: 3, spellcheck: false});
  else {
    input = el('input', {id, type: spec.secret ? 'password' : ['integer', 'number'].includes(spec.type) ? 'number' : 'text', autocomplete: 'off', spellcheck: false});
    if (spec.secret) input.placeholder = '留空保留已保存值';
    if (spec.minimum !== undefined) input.min = spec.minimum;
    if (spec.maximum !== undefined) input.max = spec.maximum;
  }
  if (spec.maxLength && spec.type === 'string' && !spec.enum) input.maxLength = spec.maxLength;
  input.dataset.setting = key;
  inputs.set(key, input);
  return input;
}

function field(key) {
  const spec = schema[key], ui = OPTIONS[key] ?? {}, input = control(key), label = ui.label ?? spec.title ?? key;
  if (spec.type === 'boolean') return el('div', {className: 'field'}, el('label', {className: 'check'}, input, label));
  const wrap = el('div', {className: 'field'}, el('label', {htmlFor: input.id, textContent: label}), input), help = ui.help ?? spec.description;
  if (help) wrap.append(el('small', {textContent: help}));
  return wrap;
}

function fill(values) {
  for (const [key, input] of inputs) {
    const value = values[key] ?? schema[key].default ?? '';
    if (schema[key].type === 'boolean') input.checked = value === true;
    else input.value = String(value);
  }
}

// Throws with the field focused when a value does not match its schema type.
function readValues() {
  const values = {};
  for (const [key, input] of inputs) {
    const spec = schema[key];
    if (spec.type === 'boolean') values[key] = input.checked;
    else if (['integer', 'number'].includes(spec.type)) {
      const number = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(number) || spec.type === 'integer' && !Number.isInteger(number) || number < (spec.minimum ?? -Infinity) || number > (spec.maximum ?? Infinity)) {
        input.focus();
        throw new Error(`“${spec.title ?? key}”需要 ${spec.minimum ?? ''}–${spec.maximum ?? ''} 之间的整数。`);
      }
      values[key] = number;
    } else values[key] = input.value;
  }
  return values;
}

function decoder() {
  const value = info.voice?.decoder;
  return value ? {checked: value.checked === true, decoder: value.decoder === true, ...(typeof value.reason === 'string' ? {reason: value.reason.slice(0, 200)} : {})} : {checked: false, decoder: false};
}

function setState(label, message, state = 'pending') {
  $('#state').textContent = label;
  $('#state').className = 'tag ' + (STATES.has(state) ? state : 'pending');
  $('#note').textContent = message;
}

function attemptState(attempt) {
  if (attempt.ok) setState('最近语音转写成功', '微信语音已收到并完成转写（' + time(attempt.at) + '）。', 'ok');
  else setState('语音已收到，转写失败', '最近一次微信语音转写失败（' + attempt.code + '，' + time(attempt.at) + '）。请测试识别后检查设置。', 'error');
}

function setModelOptions(models, placeholder) {
  const list = $('#model-list');
  list.replaceChildren(el('option', {value: '', textContent: placeholder}), ...models.map(model => el('option', {value: model.id, textContent: model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id})));
  list.disabled = models.length === 0;
  syncModel();
}

function syncModel() {
  const list = $('#model-list');
  list.value = inputs.get('model').value;
  if (!list.value) list.selectedIndex = 0;
}

function checkItem(state, label, ...rest) {
  return el('li', {className: 'check-row ' + (STATES.has(state) ? state : 'pending')}, el('span', {textContent: label}), el('div', {}, ...rest));
}

function paint(report) {
  const attempt = info.voice?.lastAttempt;
  if (!dirty && attempt && attempt.at > (report.probe?.testedAt ?? 0)) attemptState(attempt);
  else setState(report.summary.label, report.summary.message, report.summary.state);
  const labels = {ok: '通过', error: '需处理', warning: '注意'};
  const rows = (report.configuration?.checks ?? []).map(check => checkItem(check.state, labels[check.state] ?? '待确认', check.message));
  if (report.probe) {
    const probe = report.probe, parts = [probe.message];
    if (probe.code) parts.push(el('small', {textContent: '错误码：' + probe.code}));
    if (probe.testedAt) parts.push(el('small', {textContent: '语音测试时间：' + time(probe.testedAt)}));
    if (probe.text) parts.push(el('q', {textContent: probe.text}));
    rows.push(checkItem(probe.verified ? 'ok' : 'warning', '接口测试', ...parts));
  }
  if (!dirty && attempt) rows.push(checkItem(attempt.ok ? 'ok' : 'error', '最近微信语音', attempt.ok ? '已收到并完成转写' : '已收到，转写失败：' + attempt.code, el('small', {textContent: time(attempt.at)})));
  $('#checks').replaceChildren(...rows);
  if (report.models) {
    const candidates = report.models.ok ? (report.models.models ?? []).filter(model => model.audioCandidate && model.transportHint !== 'websocket') : [];
    setModelOptions(candidates, candidates.length ? '请选择模型' : '没有可选模型');
    $('#model-hint').textContent = report.models.ok
      ? candidates.length ? `已读取 ${candidates.length} 个语音候选。可下拉选择或手动填写模型 ID。` : '模型列表中没有语音候选。可手动填写平台提供的模型 ID。'
      : report.models.message ?? '此服务不能读取模型列表。可手动填写模型名，再测试识别。';
  }
}

function busy(value) {
  $('#read-models').disabled = value;
  $('#check-api').disabled = value;
}

async function run(kind) {
  clearTimeout(timer);
  const own = ++sequence;
  let settings;
  try { settings = readValues(); } catch (error) { setState('需要检查设置', error.message, 'error'); return; }
  busy(true);
  setState(kind === 'check' ? '正在测试…' : '正在连接…', kind === 'check' ? '正在转写内置短句，请稍候。' : '正在连接服务并读取模型列表，不上传语音。');
  try {
    const report = await wa.actions.call(kind, {settings, decoder: decoder()});
    if (own === sequence) paint(report);
  } catch (error) {
    if (own === sequence) setState('需要检查设置', error.message, 'error');
  } finally {
    if (own === sequence) busy(false);
  }
}

const validEndpoint = () => {
  try { return ['http:', 'https:'].includes(new URL(inputs.get('endpoint').value.trim()).protocol); } catch { return false; }
};
const autoRead = () => inputs.get('autoReadModels')?.checked ?? true;

function changed(event) {
  const key = event.target.dataset?.setting;
  if (!key) return;
  clearTimeout(timer);
  sequence++;
  busy(false);
  dirty = true;
  setState('设置已变化', '请测试识别后保存；之前的测试结果已失效。');
  $('#checks').replaceChildren();
  if (key === 'model') syncModel();
  if (/^https?:\/\//i.test(inputs.get('model').value)) setState('模型名填写有误', '这里填写模型名字，不能填写网址。', 'error');
  if (REQUEST_FIELDS.has(key) && key !== 'apiProtocol' && inputs.get('apiProtocol').value === 'auto') $('#note').textContent += ' 已修改请求格式，建议在“服务类型”中明确选择协议。';
  if (CONNECTION_FIELDS.has(key)) {
    setModelOptions([], '请先读取模型列表');
    $('#model-hint').textContent = '连接设置已变化，请重新读取模型列表或手动填写模型 ID。';
    if (autoRead() && validEndpoint() && info.runAllowed) timer = setTimeout(() => void run('models'), 900);
  }
}

try {
  const [host, current] = await Promise.all([wa.info(), wa.settings.get()]);
  info = host;
  schema = current.schema;
  $('#connection-fields').append(...CONNECTION.filter(key => schema[key]).map(field));
  const model = control('model');
  model.placeholder = '手动填写模型 ID';
  model.setAttribute('aria-describedby', 'model-hint');
  $('#model-input').replaceWith(model);
  $('#model-label').textContent = schema.model.title ?? '识别模型';
  $('#advanced-fields').append(...ADVANCED.filter(key => schema[key]).map(field));
  // Keep any schema field this page does not place, so saving never drops it.
  const placed = new Set([...CONNECTION, 'model', ...ADVANCED]);
  $('#advanced-fields').append(...Object.keys(schema).filter(key => !placed.has(key)).map(field));
  fill(current.values);
  $('#run-note').hidden = info.runAllowed === true;
  if (info.voice?.decoder?.checked && !info.voice.decoder.decoder && current.values.audioFormat !== 'silk') setState('转换组件未就绪', '本机微信语音转 WAV 组件未就绪；请检查宿主运行环境，或在平台支持时改用 silk。', 'error');
  else if (info.voice?.lastAttempt) attemptState(info.voice.lastAttempt);
  document.addEventListener('input', changed);
  document.addEventListener('change', changed);
  $('#model-list').addEventListener('change', () => {
    if (!$('#model-list').value) return;
    inputs.get('model').value = $('#model-list').value;
    changed({target: inputs.get('model')});
  });
  $('#read-models').addEventListener('click', () => void run('models'));
  $('#check-api').addEventListener('click', () => void run('check'));
  if (autoRead() && validEndpoint() && info.runAllowed) timer = setTimeout(() => void run('models'), 150);
  wa.on('run-allowed', ({runAllowed} = {}) => {
    info.runAllowed = runAllowed === true;
    $('#run-note').hidden = info.runAllowed;
    if (info.runAllowed && autoRead() && validEndpoint() && !$('#model-list').options[1]) timer = setTimeout(() => void run('models'), 150);
  });
} catch (error) {
  $('#error').textContent = error.message;
}

// Host save button: return this page's values. Enabling also runs the
// plugin's offline configuration check so an invalid setup is not switched on.
wa.onCollect(async ({enabled} = {}) => {
  clearTimeout(timer);
  sequence++;
  const values = readValues();
  if (enabled) {
    const result = await wa.actions.call('validate', {settings: values, decoder: decoder()});
    if (!result.ok) throw new Error(result.message);
  }
  return values;
});
