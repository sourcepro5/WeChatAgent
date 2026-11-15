import wa from './__sdk.mjs';
import {PLATFORMS, PROTOCOL_NAMES, platformById, detectPlatform, platformPatch, cleanApiKey, endpointAdvice, rankModels} from './helpers.mjs';

// Layout and wording for the package's own settings page. Field types and
// limits still come from plugin.json's configSchema via wa.settings.get().
const CONNECTION = ['endpoint', 'apiKey'];
const ADVANCED_GROUPS = [
  ['请求格式', ['apiProtocol', 'requestMode', 'audioFormat', 'language', 'fileField', 'modelField', 'languageField', 'extraFieldsJson', 'jsonTemplate']],
  ['返回结果', ['responseMode', 'responsePath']],
  ['鉴权', ['authHeader', 'authPrefix', 'headersJson']],
  ['模型列表', ['modelsEndpoint', 'modelsResponsePath', 'autoReadModels']],
  ['限制与缓存', ['timeoutMs', 'maxDurationSeconds', 'maxTranscriptChars', 'cacheResults']],
];
const OPTIONS = {
  endpoint: {label: '服务地址', help: '选择平台后会自动填好。其他平台请从平台文档复制 API 基础地址（通常以 /v1 结尾）。'},
  apiKey: {label: 'API 密钥', help: '粘贴平台给你的密钥即可，多余的 Bearer、引号和空格会自动去掉。本机服务通常不需要。'},
  apiProtocol: {
    label: '请求协议',
    help: '选择平台后会自动设置。“自动”按地址判断：基础地址使用文件转写，/chat/completions 结尾的地址使用 Chat 音频。',
    enumLabels: {auto: '自动（按地址判断）', 'openai-transcriptions': '文件转写（/audio/transcriptions）', 'openai-chat': 'Chat 音频（Base64）', 'chat-audio-data-url': 'Chat 音频（Data URL）', 'anthropic-messages': 'Anthropic Messages（不能转写语音）', custom: '自定义请求（使用下方模板）'},
    hidden: ['anthropic-messages'],
  },
};
const LONG_TEXT = new Set(['jsonTemplate', 'extraFieldsJson']);
const REQUEST_FIELDS = new Set(['requestMode', 'audioFormat', 'fileField', 'modelField', 'languageField', 'extraFieldsJson', 'jsonTemplate', 'responseMode', 'responsePath']);
const CONNECTION_FIELDS = new Set(['apiProtocol', 'requestMode', 'endpoint', 'apiKey', 'authHeader', 'authPrefix', 'headersJson', 'modelsEndpoint', 'modelsResponsePath', 'autoReadModels']);
const STATES = new Set(['ok', 'error', 'warning', 'pending']);
const $ = selector => document.querySelector(selector);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const time = value => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});

let schema = {}, info = {}, sequence = 0, timer, dirty = false, readModels = [];
const inputs = new Map(), notes = new Map();

function control(key) {
  const spec = schema[key], ui = OPTIONS[key] ?? {}, id = 'field-' + key;
  let input;
  if (spec.type === 'boolean') input = el('input', {type: 'checkbox', id});
  else if (spec.enum) input = el('select', {id}, ...spec.enum.map(value => el('option', {value, textContent: ui.enumLabels?.[value] ?? value, hidden: ui.hidden?.includes(value) ?? false})));
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
  const note = el('div', {className: 'advice', hidden: true});
  notes.set(key, note);
  wrap.append(note);
  if (help) wrap.append(el('small', {textContent: help}));
  return wrap;
}

function fill(values) {
  for (const [key, input] of inputs) {
    const value = values[key] ?? schema[key].default ?? '';
    if (schema[key].type === 'boolean') input.checked = value === true;
    else input.value = String(value);
    if (input.tagName === 'SELECT') for (const option of input.options) if (option.value === input.value) option.hidden = false;
  }
}

// Current text values without number validation (for platform detection).
function rawValues() {
  return Object.fromEntries([...inputs].map(([key, input]) => [key, schema[key].type === 'boolean' ? input.checked : input.value]));
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
        $('#advanced').open = true;
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

function showAdvice(key, advice, actions = []) {
  const note = notes.get(key);
  if (!note) return;
  note.className = 'advice ' + (advice?.state ?? '');
  note.replaceChildren(...(advice?.message ? [el('span', {textContent: advice.message}), ...actions] : []));
  note.hidden = !advice?.message;
}

// ---- Step 1: platform, endpoint and key ----

function platformTip(id) {
  const item = platformById(id);
  $('#platform-tip').textContent = item?.tip ?? '不确定选哪个时，选择“其他 OpenAI 兼容平台”，再粘贴平台文档里的地址。';
  $('#key-link').hidden = !item?.keyUrl;
  $('#key-url').value = item?.keyUrl ?? '';
}

// Follows the fields; an unrecognised (e.g. half-typed) address keeps the
// user's current choice instead of jumping back to the placeholder.
function syncPlatform({initial = false} = {}) {
  const id = detectPlatform(rawValues()), select = $('#platform');
  if (!id && !initial) return select.value;
  select.value = id;
  if (!id) select.selectedIndex = 0;
  platformTip(id);
  return id;
}

function choosePlatform(id) {
  const patch = platformPatch(id, rawValues()), changedKeys = [];
  for (const [key, value] of Object.entries(patch)) {
    const input = inputs.get(key);
    if (!input || input.value === String(value)) continue;
    input.value = String(value);
    changedKeys.push(key);
  }
  platformTip(id);
  if (id === 'custom') $('#advanced').open = true;
  updateEndpointAdvice();
  presetModels();
  if (changedKeys.length) afterChange(changedKeys, '已按所选平台填好地址、请求方式和推荐模型。');
}

function updateEndpointAdvice() {
  const input = inputs.get('endpoint'), advice = endpointAdvice(input.value, $('#platform').value), actions = [];
  if (advice.fix !== undefined || advice.moveToKey) {
    actions.push(el('button', {type: 'button', className: 'fix', textContent: advice.fixLabel ?? '自动修正', onclick() {
      const keys = ['endpoint'];
      if (advice.moveToKey) { inputs.get('apiKey').value = cleanApiKey(input.value).value; keys.push('apiKey'); }
      input.value = advice.fix ?? '';
      updateEndpointAdvice();
      syncPlatform();
      afterChange(keys, advice.moveToKey ? '已把密钥移到“API 密钥”栏。' : '已修正服务地址。');
    }}));
  }
  showAdvice('endpoint', advice, actions);
}

function tidyKey() {
  const input = inputs.get('apiKey'), {value, removed} = cleanApiKey(input.value);
  if (value === input.value) return false;
  input.value = value;
  showAdvice('apiKey', {state: 'ok', message: '已自动去掉' + removed.join('、') + '。'});
  return true;
}

function runGate() {
  const allowed = info.runAllowed === true, reason = allowed ? '' : '请先勾选页面上方的“允许此插件运行”。';
  $('#run-note').hidden = allowed;
  for (const id of ['#read-models', '#check-api']) $(id).disabled = !allowed || $(id).dataset.busy === '1';
  $('#read-reason').textContent = reason;
  $('#check-reason').textContent = reason;
}

// ---- Step 2: models ----

function setModelOptions(models, placeholder) {
  const list = $('#model-list'), {recommended, others} = rankModels(models, $('#platform').value);
  const option = model => el('option', {value: model.id, textContent: model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id});
  const groups = [];
  if (recommended.length) groups.push(el('optgroup', {label: '推荐（语音识别模型）'}, ...recommended.map(option)));
  if (others.length) groups.push(el('optgroup', {label: recommended.length ? '其他模型（多半不支持语音）' : '全部模型'}, ...others.map(option)));
  list.replaceChildren(el('option', {value: '', textContent: placeholder}), ...groups);
  list.disabled = models.length === 0;
  syncModel();
}

function presetModels() {
  if (readModels.length) return setModelOptions(readModels, '请选择模型');
  const item = platformById($('#platform').value);
  if (item?.models.length) {
    setModelOptions(item.models.map(id => ({id})), '请选择模型');
    $('#model-hint').textContent = '已列出该平台常用的语音识别模型，也可读取完整模型列表或手动填写。';
  } else {
    setModelOptions([], '请先读取模型列表');
    $('#model-hint').textContent = '点击“连接并读取模型”后可从下拉中选择，也可直接填写平台提供的模型名称。';
  }
}

function syncModel() {
  const list = $('#model-list');
  list.value = inputs.get('model').value;
  if (!list.value) list.selectedIndex = 0;
}

// ---- Step 3: test results ----

function attemptState(attempt) {
  if (attempt.ok) setState('最近语音转写成功', '微信语音已收到并完成转写（' + time(attempt.at) + '）。', 'ok');
  else setState('语音已收到，转写失败', '最近一次微信语音转写失败（' + attempt.code + '，' + time(attempt.at) + '）。请测试识别后检查设置。', 'error');
}

function checkItem(state, label, ...rest) {
  return el('li', {className: 'check-row ' + (STATES.has(state) ? state : 'pending')}, el('span', {textContent: label}), el('div', {}, ...rest));
}

function applySwitch(switched) {
  const from = PROTOCOL_NAMES[switched.from] ?? switched.from, to = PROTOCOL_NAMES[switched.apiProtocol] ?? switched.apiProtocol;
  for (const key of ['apiProtocol', 'endpoint', 'requestMode', 'audioFormat', 'responseMode', 'responsePath']) {
    if (switched[key] !== undefined && inputs.get(key)) inputs.get(key).value = String(switched[key]);
  }
  dirty = true;
  syncPlatform();
  updateEndpointAdvice();
  $('#switch-note').textContent = `平台不接受“${from}”方式，已自动改用“${to}”并测试成功。点击上方“保存插件设置”后生效。`;
  $('#switch-note').hidden = false;
}

function paint(report) {
  const attempt = info.voice?.lastAttempt;
  if (report.switched) applySwitch(report.switched);
  if (!dirty && attempt && attempt.at > (report.probe?.testedAt ?? 0)) attemptState(attempt);
  else setState(report.summary.label, report.summary.message, report.summary.state);
  const labels = {ok: '通过', error: '需处理', warning: '注意'};
  const rows = (report.configuration?.checks ?? []).map(check => checkItem(check.state, labels[check.state] ?? '待确认', check.message));
  if (report.attempts?.length > 1) rows.push(checkItem(report.switched ? 'ok' : 'error', '请求方式', ...report.attempts.map(item => el('small', {textContent: `${PROTOCOL_NAMES[item.protocol] ?? item.protocol}：${item.ok ? '成功' : '失败（' + item.code + '）'}`}))));
  if (report.probe) {
    const probe = report.probe, parts = [probe.message];
    if (probe.code) parts.push(el('small', {textContent: '错误码：' + probe.code}));
    if (probe.testedAt) parts.push(el('small', {textContent: '语音测试时间：' + time(probe.testedAt)}));
    if (probe.text) parts.push(el('q', {textContent: probe.text}));
    rows.push(checkItem(probe.verified ? 'ok' : 'warning', '接口测试', ...parts));
  }
  if (!dirty && attempt) rows.push(checkItem(attempt.ok ? 'ok' : 'error', '最近微信语音', attempt.ok ? '已收到并完成转写' : '已收到，转写失败：' + attempt.code, el('small', {textContent: time(attempt.at)})));
  $('#checks').replaceChildren(...rows);
  if (report.probe && !report.probe.ok && report.attempts?.length > 1) $('#note').textContent += ' 已尝试所有标准请求方式，请确认所选模型支持语音识别。';
  $('#next-step').hidden = report.probe?.ok !== true;
  if (report.models) {
    readModels = report.models.ok ? (report.models.models ?? []).filter(model => model.audioCandidate && model.transportHint !== 'websocket') : [];
    if (readModels.length) {
      setModelOptions(readModels, '请选择模型');
      const {recommended} = rankModels(readModels, $('#platform').value);
      $('#model-hint').textContent = `已读取 ${readModels.length} 个模型，其中 ${recommended.length} 个看起来是语音识别模型（排在最前）。也可手动填写。`;
    } else {
      presetModels();
      $('#model-hint').textContent = report.models.ok ? '模型列表中没有可选模型，可手动填写平台提供的模型名称。' : (report.models.message ?? '此服务不能读取模型列表。') + ' 可直接填写模型名称后测试。';
    }
  }
}

function busy(value) {
  for (const id of ['#read-models', '#check-api']) $(id).dataset.busy = value ? '1' : '';
  runGate();
}

async function run(kind) {
  clearTimeout(timer);
  if (!info.runAllowed) { runGate(); return; }
  const own = ++sequence;
  tidyKey();
  let settings;
  try { settings = readValues(); } catch (error) { setState('需要检查设置', error.message, 'error'); return; }
  busy(true);
  $('#switch-note').hidden = true;
  setState(kind === 'check' ? '正在测试…' : '正在连接…', kind === 'check' ? '正在转写内置短句，请稍候。必要时会换一种请求方式再试，最长约 30 秒。' : '正在连接服务并读取模型列表，不上传语音。');
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

// Shared by user edits and programmatic fills (platform choice, fixes).
function afterChange(keys, message = '请重新测试识别后保存；之前的测试结果已失效。') {
  clearTimeout(timer);
  sequence++;
  busy(false);
  dirty = true;
  setState('设置已变化', message.includes('测试') ? message : message + ' 请测试识别后保存。');
  $('#checks').replaceChildren();
  $('#switch-note').hidden = true;
  $('#next-step').hidden = true;
  if (keys.includes('model')) syncModel();
  if (/^https?:\/\//i.test(inputs.get('model').value)) setState('模型名填写有误', '这里填写模型名字，不能填写网址。', 'error');
  if (keys.some(key => REQUEST_FIELDS.has(key)) && inputs.get('apiProtocol').value === 'auto') $('#note').textContent += ' 已修改请求格式，建议在“请求协议”中明确选择协议。';
  if (keys.some(key => CONNECTION_FIELDS.has(key))) {
    readModels = [];
    presetModels();
    if (autoRead() && validEndpoint() && info.runAllowed && endpointAdvice(inputs.get('endpoint').value).state !== 'error') timer = setTimeout(() => void run('models'), 900);
  }
}

function changed(event) {
  const key = event.target.dataset?.setting;
  if (!key) return;
  if (key === 'endpoint') { updateEndpointAdvice(); syncPlatform(); }
  if (key === 'apiKey') showAdvice('apiKey', null);
  if (key === 'apiProtocol' || key === 'requestMode') syncPlatform();
  afterChange([key]);
}

try {
  const [host, current] = await Promise.all([wa.info(), wa.settings.get()]);
  info = host;
  schema = current.schema;
  const platform = $('#platform');
  platform.append(el('option', {value: '', textContent: '请选择平台…', disabled: true}), ...PLATFORMS.map(item => el('option', {value: item.id, textContent: item.name})));
  $('#connection-fields').append(...CONNECTION.filter(key => schema[key]).map(field));
  const model = control('model');
  model.placeholder = '或直接填写模型名称';
  model.setAttribute('aria-describedby', 'model-hint');
  $('#model-input').replaceWith(model);
  $('#model-label').textContent = schema.model.title ?? '识别模型';
  const placed = new Set([...CONNECTION, 'model']);
  for (const [title, keys] of ADVANCED_GROUPS) {
    const present = keys.filter(key => schema[key]);
    present.forEach(key => placed.add(key));
    if (present.length) $('#advanced-fields').append(el('h4', {textContent: title}), el('div', {className: 'grid two'}, ...present.map(field)));
  }
  // Keep any schema field this page does not place, so saving never drops it.
  const rest = Object.keys(schema).filter(key => !placed.has(key));
  if (rest.length) $('#advanced-fields').append(el('h4', {textContent: '其他'}), el('div', {className: 'grid two'}, ...rest.map(field)));
  fill(current.values);
  syncPlatform({initial: true});
  updateEndpointAdvice();
  presetModels();
  if (inputs.get('apiProtocol').value === 'custom' && $('#platform').value === 'custom') $('#advanced').open = true;
  runGate();
  if (info.voice?.decoder?.checked && !info.voice.decoder.decoder && current.values.audioFormat !== 'silk') setState('转换组件未就绪', '本机微信语音转 WAV 组件未就绪；请检查宿主运行环境，或在平台支持时改用 silk。', 'error');
  else if (info.voice?.lastAttempt) attemptState(info.voice.lastAttempt);
  else if (!current.values.endpoint) setState('尚未设置', '先在第 1 步选择平台。');
  document.addEventListener('input', changed);
  // Selects and checkboxes also fire "input"; "change" only tidies the key.
  document.addEventListener('change', event => {
    if (event.target.dataset?.setting === 'apiKey' && tidyKey()) afterChange(['apiKey']);
  });
  inputs.get('apiKey').addEventListener('paste', () => setTimeout(() => { if (tidyKey()) afterChange(['apiKey']); }));
  platform.addEventListener('change', () => choosePlatform(platform.value));
  $('#key-url').addEventListener('focus', event => event.target.select());
  $('#model-list').addEventListener('change', () => {
    if (!$('#model-list').value) return;
    inputs.get('model').value = $('#model-list').value;
    afterChange(['model']);
  });
  $('#read-models').addEventListener('click', () => void run('models'));
  $('#check-api').addEventListener('click', () => void run('check'));
  if (autoRead() && validEndpoint() && info.runAllowed) timer = setTimeout(() => void run('models'), 150);
  wa.on('run-allowed', ({runAllowed} = {}) => {
    info.runAllowed = runAllowed === true;
    runGate();
    if (info.runAllowed && autoRead() && validEndpoint() && !readModels.length) timer = setTimeout(() => void run('models'), 150);
  });
} catch (error) {
  $('#error').textContent = error.message;
}

// Host save button: return this page's values. Enabling also runs the
// plugin's offline configuration check so an invalid setup is not switched on.
wa.onCollect(async ({enabled} = {}) => {
  clearTimeout(timer);
  sequence++;
  tidyKey();
  const values = readValues();
  if (enabled) {
    const result = await wa.actions.call('validate', {settings: values, decoder: decoder()});
    if (!result.ok) throw new Error(result.message);
  }
  return values;
});
