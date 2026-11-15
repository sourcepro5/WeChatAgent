import wa from './__sdk.mjs';
import {FAILURE_FIELDS, cleanApiKey, endpointAdvice, rankModels} from './helpers.mjs';
import {AUTH_MODES, CAPABILITIES, CAPABILITY_IDS, CUSTOM, KEY_FIELDS, STATUS, WEBSOCKET_KINDS, activeOf, defaultProfile,
  entryById, hostSettings, methodOf, methodsOf, ownerFor, profileKey, providersFor, servicesOf} from './providers.mjs';
import {cloneAudioLimit, cloneTarget} from './qwen-clone.mjs';

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.includes('-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}
const LEGACY_FIELDS = ['endpoint', 'model', 'voice', 'speed', 'recognitionEndpoint', 'realtimeModel', 'realtimeEndpoint', 'realtimeProtocol'];
// Lists the service can return (GET /models or the provider's own list).
const LISTABLE_KINDS = new Set(['openai-speech', 'openai-transcriptions', 'openai-transcription', 'realtime-speak']);
const LISTABLE_ENTRIES = new Set(['elevenlabs', 'azure', 'google']);
const RECOGNITION_CAPABILITY = {realtime: 'realtimeAsr', file: 'fileAsr'};
const each = () => Object.fromEntries(CAPABILITY_IDS.map(capability => [capability, undefined]));

let stored, services, info = {}, editing = null, runAllowed = false, busy = false, generation = 0, cloneBusy = false, readyClone, sourcesTimer;
// Credentials typed on this page, per capability and service; never shown again once saved.
const typedKeys = {tts: {}, realtimeAsr: {}, fileAsr: {}};
// The tab chosen in an editor before a service is picked.
const pendingSource = {};
const lists = {tts: {models: [], voices: []}, realtimeAsr: {models: [], voices: []}, fileAsr: {models: [], voices: []}};
// Latest test result per capability: {state: 'ok' | 'error' | 'pending' | null, lines: [{label, text, state, list}], preview}.
const tests = each(), notes = each(), moreOpen = each();
let sources = {};

const active = capability => activeOf(services, capability);
const typedOf = capability => typedKeys[capability][services[capability].entry] ?? '';
const nameOf = entry => entryById(entry)?.name ?? '';
const recognitionCapability = () => RECOGNITION_CAPABILITY[services.recognition] ?? '';
// The editable profile object of a capability's selected method.
function profileOf(capability) {
  const slot = services[capability], key = profileKey(slot.entry, slot.method);
  slot.profiles[key] = {...defaultProfile(capability, slot.entry, slot.method), ...slot.profiles[key]};
  return slot.profiles[key];
}

function showAdvice(key, advice, actions = []) {
  const note = document.querySelector(`[data-advice="${key}"]`);
  if (!note) return;
  note.className = 'advice ' + (advice?.state ?? '');
  note.replaceChildren(...(advice?.message ? [el('span', {textContent: advice.message}), ...actions] : []));
  note.hidden = !advice?.message;
  // A problem in a collapsed section opens it.
  if (advice?.state === 'error') for (let node = note.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
}

function serviceName(capability) {
  const {entry, profile: values} = active(capability);
  if (!entry) return '';
  return entry === 'custom' ? '自定义 API' + (values.name ? '：' + values.name : '') : nameOf(entry);
}
// Long IDs (for example cloned voices) are shortened for display; the full value is in the tooltip.
const shortId = value => { const text = String(value ?? ''); return text.length > 40 ? text.slice(0, 24) + '…' + text.slice(-8) : text; };

// ---- values for saving and testing ----

function values() {
  const seconds = Number($('timeout-seconds').value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 25) {
    showAdvice('timeoutMs', {state: 'error', message: '请填写 1–25 之间的整数秒数。'});
    throw new Error('高级设置中的“等待服务响应的最长时间”需要 1–25 秒。');
  }
  showAdvice('timeoutMs', null);
  const next = structuredClone(services);
  // A typed credential belongs to the service (and custom addresses) it was typed for.
  for (const capability of CAPABILITY_IDS) if (typedOf(capability)) next.owners[capability] = ownerFor(capability, activeOf(next, capability));
  return {
    ...Object.fromEntries(LEGACY_FIELDS.map(key => [key, stored[key] ?? (key === 'speed' ? 1 : key === 'realtimeProtocol' ? 'auto' : '')])),
    ...hostSettings(next), instructions: $('instructions').value, timeoutMs: seconds * 1000, services: next, apiKey: '',
    ...Object.fromEntries(CAPABILITY_IDS.map(capability => [KEY_FIELDS[capability], typedOf(capability)])),
  };
}

// ---- credentials ----

function keyHint(capability) {
  if (typedOf(capability)) return '已填写，保存后生效。';
  const from = sources[capability];
  if (from === capability) return '已保存，留空即可。';
  if (CAPABILITY_IDS.includes(from)) return `沿用「${CAPABILITIES[from].label}」中保存的同一服务凭据，留空即可。`;
  if (from === 'legacy') return '沿用之前保存的密钥，留空即可。';
  if (from === 'none') return '还没有可用于这个服务的凭据，请填写。';
  return '留空保留已保存的凭据（如有）。';
}

function missingCredential(capability) {
  const {entry, profile: values} = active(capability);
  return !!entry && !(entry === 'custom' && values.auth === 'none') && !typedOf(capability) && sources[capability] === 'none';
}

// Asks the plugin which saved credential each capability would use (never its content).
function refreshSources() {
  clearTimeout(sourcesTimer);
  if (!runAllowed) return;
  sourcesTimer = setTimeout(async () => {
    let settings;
    try { settings = values(); } catch { return; }
    try {
      const response = await wa.actions.call('credentials', {settings});
      if (!response.ok) return;
      sources = response.sources;
      for (const node of document.querySelectorAll('[data-key-hint]')) node.textContent = keyHint(node.dataset.keyHint);
      renderHeaders();
    } catch {}
  }, 300);
}

function setTyped(capability, value) {
  typedKeys[capability][services[capability].entry] = value;
  for (const node of document.querySelectorAll('[data-key-hint]')) node.textContent = keyHint(node.dataset.keyHint);
}

function tidy(input) {
  const {value, removed} = cleanApiKey(input.value);
  if (value === input.value) return;
  input.value = value;
  showAdvice('key', {state: 'ok', message: '已自动去掉' + removed.join('、') + '。'});
}

// A pasted or selected service account JSON, checked locally and stored minified.
function googleJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) { showAdvice('key', null); return ''; }
  try {
    const account = JSON.parse(text);
    if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string') throw Error();
    showAdvice('key', {state: 'ok', message: '已读取服务账号 ' + account.client_email + '，保存后生效。'});
    return JSON.stringify(account);
  } catch {
    showAdvice('key', {state: 'error', message: '这不是有效的服务账号 JSON（需要 type 为 service_account，并包含 client_email 和 private_key）。'});
    return '';
  }
}

// ---- the three summary rows ----

function currentText(capability) {
  const {entry, definition, profile: values} = active(capability);
  if (!entry) return {text: CAPABILITIES[capability].hint, title: ''};
  const parts = [serviceName(capability), values.model ? shortId(values.model) : definition.label];
  if (capability === 'tts' && values.voice) parts.push('音色 ' + shortId(values.voice));
  return {text: parts.join(' · '), title: [serviceName(capability), definition.label, values.model, capability === 'tts' ? values.voice : ''].filter(Boolean).join(' · ')};
}

function statusOf(capability) {
  if (!active(capability).entry) return {label: '未配置', state: ''};
  const state = tests[capability]?.state;
  if (state === 'pending') return {label: '测试中…', state: ''};
  if (state === 'ok') return {label: '测试通过', state: 'ok'};
  if (state === 'error') return {label: '测试失败', state: 'error'};
  if (missingCredential(capability)) return {label: '缺少凭据', state: 'warning'};
  return {label: '已配置', state: 'ok'};
}

const testLabel = capability => capability === 'tts' ? (services.reply === 'direct' ? '测试对话' : '试听') : '测试';

function renderHeader(capability) {
  const configured = !!active(capability).entry, status = statusOf(capability), current = currentText(capability);
  const blocked = !runAllowed || busy || cloneBusy;
  const test = el('button', {type: 'button', id: 'test-' + capability, textContent: testLabel(capability), disabled: !configured || blocked,
    title: !configured ? '先添加服务' : !runAllowed ? '请先勾选页面上方的“允许此插件运行”' : ''});
  test.addEventListener('click', () => void runTest(capability));
  const edit = el('button', {type: 'button', id: 'edit-' + capability, className: configured ? '' : 'primary',
    textContent: editing === capability ? '收起' : configured ? '编辑' : '添加'});
  edit.setAttribute('aria-expanded', String(editing === capability));
  edit.addEventListener('click', () => toggleEditor(capability));
  $('head-' + capability).replaceChildren(
    el('div', {className: 'cap-info'},
      el('div', {className: 'cap-name'}, CAPABILITIES[capability].label,
        el('span', {className: 'tag ' + status.state, id: 'status-' + capability, textContent: status.label}),
        capability !== 'tts' && configured ? el('span', {className: 'cap ' + (recognitionCapability() === capability ? 'tested' : 'missing-use'),
          textContent: recognitionCapability() === capability ? '用于识别' : '未选用'}) : null),
      el('div', {className: 'cap-current', id: 'current-' + capability, textContent: current.text, title: current.title})),
    el('div', {className: 'cap-buttons'}, test, edit));
}
const renderHeaders = () => CAPABILITY_IDS.forEach(renderHeader);

function renderResult(capability) {
  const box = $('result-' + capability), result = tests[capability];
  box.hidden = !result?.lines?.length;
  if (box.hidden) { box.replaceChildren(); return; }
  const items = result.lines.map(line => el('li', {className: line.state ?? ''}, el('strong', {textContent: line.label}), ' ',
    line.list ? el('ol', {}, ...line.list.map(text => el('li', {textContent: text}))) : line.text));
  const nodes = [el('ul', {className: 'results'}, ...items)];
  if (result.preview) {
    const audio = el('audio', {controls: true, preload: 'none', src: 'data:audio/wav;base64,' + result.preview});
    audio.setAttribute('aria-label', '试听');
    nodes.push(audio);
    if (result.autoplay) { result.autoplay = false; void audio.play().catch(() => {}); }
  }
  box.replaceChildren(...nodes);
}

function toggleEditor(capability) {
  const previous = editing;
  editing = editing === capability ? null : capability;
  readyClone = undefined;
  if (editing) delete pendingSource[editing];
  renderHeaders();
  if (previous) renderEditor(previous);
  if (editing) renderEditor(editing);
  gate();
}

// ---- controls ----

function row(name, label, control, hint = '') {
  return el('div', {className: 'field', dataset: {field: name}},
    el('label', {textContent: label, htmlFor: control.id || control.querySelector?.('input,select')?.id || ''}), control,
    el('div', {className: 'advice', hidden: true, dataset: {advice: name}}), hint ? el('small', {textContent: hint}) : null);
}

function textInput(capability, name, value, attributes = {}) {
  const input = el('input', {id: 'f-' + name, type: 'text', spellcheck: false, autocomplete: 'off', value: value ?? '', ...attributes});
  input.addEventListener('input', () => { profileOf(capability)[name] = input.value.trim(); onFieldChange(capability, name); });
  return input;
}

const MANUAL = '\u0000manual';
// One control for picking from a list or typing any other ID. groups: [{label?, options: [{value, text}]}];
// current is the selected option value, text the ID shown when typing.
function combo({id, groups, current, text, placeholder, onPick, onType}) {
  const options = groups.flatMap(group => group.options), wrap = el('div', {className: 'combo'});
  function typing(focus) {
    const input = el('input', {id, type: 'text', spellcheck: false, autocomplete: 'off', value: text ?? '', placeholder: '填写 ID'});
    input.addEventListener('input', () => { text = input.value.trim(); onType(text); });
    const back = options.length ? el('button', {type: 'button', className: 'link', textContent: '从列表选择'}) : null;
    back?.addEventListener('click', () => picking(true));
    wrap.replaceChildren(input, back);
    if (focus) input.focus();
  }
  function picking(focus) {
    const select = el('select', {id});
    select.append(el('option', {value: '', textContent: placeholder, disabled: true}),
      ...groups.flatMap(group => {
        const items = group.options.map(option => el('option', {value: option.value, textContent: option.text}));
        return group.label && items.length ? [el('optgroup', {label: group.label}, ...items)] : items;
      }),
      el('option', {value: MANUAL, textContent: '手动填写 ID…'}));
    select.value = options.some(option => option.value === current) ? current : '';
    select.addEventListener('change', () => {
      if (select.value === MANUAL) typing(true);
      else { current = select.value; onPick(select.value); }
    });
    wrap.replaceChildren(select);
    if (focus) select.focus();
  }
  if (!options.length || text && !options.some(option => option.value === current)) typing(false); else picking(false);
  return wrap;
}

const plain = list => [{options: list.map(item => typeof item === 'string' ? {value: item, text: item}
  : {value: item.id, text: item.label === item.id || !item.label ? item.id : `${item.label}（${item.id.split(':').pop()}）`})}];
function pickField(capability, name, list, placeholder) {
  const values = profileOf(capability);
  const set = value => { values[name] = value; onFieldChange(capability, name); };
  return combo({id: 'f-' + name, groups: plain(list), current: values[name] ?? '', text: values[name] ?? '', placeholder, onPick: set, onType: set});
}

// The model list. A provider with several interfaces for this capability groups its models by
// interface, so picking a model also picks how it is called.
function modelField(capability) {
  const {entry, method, definition} = active(capability), values = profileOf(capability);
  const methods = methodsOf(entry, capability), ids = Object.keys(methods);
  const own = () => {
    const preset = definition.models ?? [], {recommended, others} = rankModels([...new Set([...preset, ...lists[capability].models])], preset);
    return [...recommended, ...others];
  };
  const grouped = entry !== 'custom' && ids.length > 1 && ids.every(id => methods[id].fields.includes('model'));
  const option = (id, model) => ({value: id + '\n' + model, text: model});
  const groups = grouped ? ids.map(id => ({label: methods[id].label, options: (id === method ? own() : methods[id].models ?? []).map(model => option(id, model))}))
    : [{options: own().map(model => option(method, model))}];
  return combo({id: 'f-model', groups, current: method + '\n' + (values.model ?? ''), text: values.model ?? '', placeholder: '请选择模型',
    onPick(value) {
      const [next, model] = value.split('\n');
      if (next === method) { values.model = model; onFieldChange(capability, 'model'); return; }
      chooseMethod(capability, entry, next, {model});
    },
    onType(text) { values.model = text; onFieldChange(capability, 'model'); }});
}

function modelLabel(capability, definition) {
  if (capability === 'tts') return '模型';
  if (['tencent-asr-ws', 'tencent-sentence'].includes(definition.kind)) return '识别引擎';
  if (['azure-stt', 'google-stt'].includes(definition.kind)) return '识别语言';
  return '模型';
}

function endpointLabel(entry, definition) {
  if (WEBSOCKET_KINDS.has(definition.kind)) return 'WebSocket 地址';
  return entry === 'custom' ? '基础地址或完整接口地址' : '服务地址';
}

function keyRow(capability, item) {
  const placeholder = '留空保留已保存的凭据';
  const hint = el('small', {textContent: keyHint(capability), dataset: {keyHint: capability}});
  const where = item.keyUrl ? el('small', {}, '获取凭据：', el('span', {className: 'selectable', textContent: item.keyUrl})) : null;
  const changed = value => { setTyped(capability, value); afterChange(capability); };
  if (item.keyKind === 'tencent') {
    const id = el('input', {id: 'f-tencent-id', type: 'password', autocomplete: 'off', placeholder: 'SecretId'});
    const secret = el('input', {id: 'f-tencent-secret', type: 'password', autocomplete: 'off', placeholder: 'SecretKey'});
    const update = () => {
      const a = id.value.trim(), b = secret.value.trim();
      showAdvice('key', !!a !== !!b ? {state: 'error', message: '请同时填写 SecretId 和 SecretKey。'} : null);
      changed(a && b ? a + ':' + b : '');
    };
    id.addEventListener('input', update);
    secret.addEventListener('input', update);
    return el('div', {className: 'field', dataset: {field: 'key'}}, el('label', {textContent: 'SecretId / SecretKey', htmlFor: 'f-tencent-id'}),
      el('div', {className: 'pair'}, id, secret), el('div', {className: 'advice', hidden: true, dataset: {advice: 'key'}}), hint, where);
  }
  if (item.keyKind === 'google') {
    const file = el('input', {id: 'f-google-file', type: 'file', accept: '.json,application/json'});
    const json = el('input', {id: 'f-google-json', type: 'password', autocomplete: 'off', placeholder: '或粘贴服务账号 JSON；' + placeholder});
    file.addEventListener('change', () => {
      const chosen = file.files[0];
      if (!chosen) return;
      if (chosen.size > 12000) { showAdvice('key', {state: 'error', message: '文件过大，请选择服务账号 JSON 密钥文件。'}); return; }
      chosen.text().then(text => { file.value = ''; json.value = ''; changed(googleJson(text)); });
    });
    json.addEventListener('input', () => changed(googleJson(json.value)));
    return el('div', {className: 'field', dataset: {field: 'key'}}, el('label', {textContent: '服务账号 JSON', htmlFor: 'f-google-file'}),
      file, json, el('div', {className: 'advice', hidden: true, dataset: {advice: 'key'}}), hint, where);
  }
  const input = el('input', {id: 'f-key', type: 'password', autocomplete: 'off', spellcheck: false, placeholder, value: typedOf(capability)});
  input.addEventListener('input', () => changed(input.value));
  input.addEventListener('change', () => { tidy(input); setTyped(capability, input.value); });
  input.addEventListener('paste', () => setTimeout(() => { tidy(input); setTyped(capability, input.value); }));
  return el('div', {className: 'field', dataset: {field: 'key'}}, el('label', {textContent: item.keyLabel ?? '密钥', htmlFor: 'f-key'}),
    input, el('div', {className: 'advice', hidden: true, dataset: {advice: 'key'}}), hint, where);
}

// ---- the editor of one capability ----

// Whether "更多设置" holds anything other than the preset values.
function customized(capability) {
  const {entry, definition, profile: values} = active(capability);
  if (!definition) return false;
  if (entry === 'custom') return !!(values.name || (values.auth ?? 'bearer') !== 'bearer' || (values.protocol ?? 'auto') !== 'auto' || values.language || (values.speed ?? 1) !== 1 || values.timeoutMs);
  return ['endpoint', 'sessionModel', 'protocol', 'language', 'speed', ...(entry === 'tencent' ? ['region'] : [])]
    .some(key => String(values[key] ?? '') !== String(definition.defaults[key] ?? ''));
}

function parkClone() { $('clone-holder').append($('voice-clone')); }

function renderEditor(capability) {
  const box = $('editor-' + capability);
  if (capability === 'tts') parkClone();
  if (editing !== capability) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const {entry, method, definition: selected} = active(capability), custom = entry === 'custom';
  // The tab being viewed. Looking at the other tab changes nothing until a service is picked there.
  const source = pendingSource[capability] ?? (custom ? 'custom' : 'provider');
  const shown = !!entry && (source === 'custom') === custom, definition = shown ? selected : undefined;
  const tab = (id, label) => {
    const button = el('button', {type: 'button', role: 'tab', id: 'tab-' + id, className: 'seg' + (source === id ? ' selected' : ''), textContent: label});
    button.setAttribute('aria-selected', String(source === id));
    button.addEventListener('click', () => { if (source !== id) chooseSource(capability, id); });
    return button;
  };
  const nodes = [
    el('div', {className: 'segmented', role: 'tablist'}, tab('provider', '第三方模型提供商'), tab('custom', '自定义 API')),
    el('small', {className: 'hint', textContent: source === 'provider' ? '从已接入的服务中选择，填写凭据后选用它的模型和音色。' : '接入本机服务、自建网关或其他兼容接口。'}),
  ];
  const basic = [], more = [];
  if (source === 'provider') {
    const available = providersFor(capability);
    const select = el('select', {id: 'f-service'}, el('option', {value: '', textContent: '请选择服务…', disabled: true}),
      ...['国内', '海外'].map(region => el('optgroup', {label: region}, ...available.filter(item => item.region === region).map(item => el('option', {value: item.id, textContent: item.name})))));
    select.value = shown ? entry : '';
    select.addEventListener('change', () => { if (select.value) chooseEntry(capability, select.value); });
    basic.push(row('service', '服务', select, shown ? entryById(entry).tip ?? '' : `列表中是支持${CAPABILITIES[capability].label}的服务；其他服务可以通过“自定义 API”接入。`));
  } else {
    const select = el('select', {id: 'f-method'}, el('option', {value: '', textContent: '请选择接口协议…', disabled: true}),
      ...Object.entries(CUSTOM[capability]).map(([id, item]) => el('option', {value: id, textContent: item.label})));
    select.value = shown ? method : '';
    select.addEventListener('change', () => { if (select.value) chooseMethod(capability, 'custom', select.value); });
    basic.push(row('method', '接口协议', select));
  }
  if (entry && !shown) basic.push(el('small', {className: 'hint', textContent: `当前使用的仍是「${serviceName(capability)}」，在这里选择后才会替换。`}));
  if (definition) {
    const item = entryById(entry), values = profileOf(capability), fields = definition.fields, has = name => fields.includes(name);
    const websocket = WEBSOCKET_KINDS.has(definition.kind);
    // Necessary values first: address (custom only), credential, required parameters, model, voice.
    if (has('endpoint')) {
      const control = textInput(capability, 'endpoint', values.endpoint, {inputMode: 'url', maxLength: 2048,
        placeholder: custom ? (websocket ? '例如 wss://gw.example.com/v1/realtime' : '例如 http://127.0.0.1:8000/v1') : definition.defaults.endpoint});
      const wrap = el('div', {}, control);
      if (!custom) {
        const reset = el('button', {type: 'button', textContent: '恢复官方地址', className: 'link'});
        reset.addEventListener('click', () => { control.value = definition.defaults.endpoint; values.endpoint = control.value; onFieldChange(capability, 'endpoint'); });
        wrap.append(reset);
      }
      (custom ? basic : more).push(row('endpoint', endpointLabel(entry, definition), wrap, custom && !websocket
        ? '只填基础地址时自动补上接口路径；带网关前缀或完整接口路径的地址按原样使用。' : ''));
    }
    if (!custom || values.auth !== 'none') basic.push(keyRow(capability, item));
    if (has('appId')) basic.push(row('appId', 'APPID', textInput(capability, 'appId', values.appId, {inputMode: 'numeric', maxLength: 20, placeholder: '在腾讯云“账号中心”查看'})));
    if (has('region')) (entry === 'tencent' ? more : basic).push(row('region', entry === 'tencent' ? '地域（可选）' : '区域（需与语音资源一致）',
      pickField(capability, 'region', (definition.regions ?? []).filter(Boolean), '请选择区域')));
    if (has('sessionModel')) (custom ? basic : more).push(row('sessionModel', 'Realtime 会话模型', pickField(capability, 'sessionModel', definition.sessionModels ?? [], '请选择')));
    if (has('model')) basic.push(row('model', modelLabel(capability, definition), modelField(capability)));
    if (has('voice')) basic.push(row('voice', '音色', pickField(capability, 'voice', lists[capability].voices.length ? lists[capability].voices : definition.voices ?? [], '请选择音色')));
    // On demand: interface, protocol details, tuning and timeout.
    if (!custom && Object.keys(methodsOf(entry, capability)).length > 1) {
      const select = el('select', {id: 'f-method'}, ...Object.entries(methodsOf(entry, capability)).map(([id, other]) => el('option', {value: id, textContent: other.label})));
      select.value = method;
      select.addEventListener('change', () => chooseMethod(capability, entry, select.value));
      more.unshift(row('method', '接入方式', select));
    }
    if (custom) {
      more.push(row('name', '服务名称（可留空）', textInput(capability, 'name', values.name, {maxLength: 60, placeholder: '例如：本机语音服务、公司语音网关'})));
      const auth = el('select', {id: 'f-auth'}, ...Object.entries(AUTH_MODES).filter(([id]) => !websocket || id !== 'header').map(([id, label]) => el('option', {value: id, textContent: label})));
      auth.value = AUTH_MODES[values.auth] && !(websocket && values.auth === 'header') ? values.auth : 'bearer';
      values.auth = auth.value;
      auth.addEventListener('change', () => { values.auth = auth.value; moreOpen[capability] = true; renderEditor(capability); refreshSources(); afterChange(capability); });
      more.push(row('auth', '鉴权方式', auth, websocket ? 'WebSocket 只支持 Bearer 或无需鉴权。' : ''));
      if (values.auth === 'header') more.push(row('authHeader', '请求头名称', textInput(capability, 'authHeader', values.authHeader, {placeholder: '例如 x-api-key', maxLength: 64})));
    }
    if (has('protocol')) {
      const select = el('select', {id: 'f-protocol'}, el('option', {value: 'auto', textContent: '自动（按地址识别）'}),
        el('option', {value: 'openai', textContent: 'OpenAI Realtime 正式版'}), el('option', {value: 'openai-beta', textContent: 'OpenAI Realtime 测试版（兼容平台）'}));
      select.value = ['auto', 'openai', 'openai-beta'].includes(values.protocol) ? values.protocol : 'auto';
      select.addEventListener('change', () => { values.protocol = select.value; onFieldChange(capability, 'protocol'); });
      more.push(row('protocol', 'Realtime 事件格式', select));
    }
    if (has('language')) more.push(row('language', '识别语言（可留空，自动识别）', textInput(capability, 'language', values.language, {maxLength: 3, placeholder: '例如 zh'})));
    if (has('speed')) {
      const [min, max] = entry === 'elevenlabs' ? [0.7, 1.2] : [0.5, 2];
      const range = el('input', {id: 'f-speed', type: 'range', min, max, step: 0.1, value: String(values.speed ?? 1)});
      const output = el('output', {textContent: Number(range.value).toFixed(1)});
      range.addEventListener('input', () => { output.textContent = Number(range.value).toFixed(1); values.speed = Math.round(Number(range.value) * 10) / 10; afterChange(capability); });
      more.push(el('div', {className: 'field', dataset: {field: 'speed'}}, el('label', {htmlFor: 'f-speed'}, '语速 ', output), range));
    }
    if (custom && has('timeoutMs')) {
      const seconds = el('input', {id: 'f-timeout', type: 'number', min: 1, max: 25, step: 1, placeholder: '留空使用高级设置中的时间', value: values.timeoutMs ? String(values.timeoutMs / 1000) : ''});
      seconds.addEventListener('input', () => {
        const value = Number(seconds.value);
        if (!seconds.value) delete values.timeoutMs;
        else if (Number.isInteger(value) && value >= 1 && value <= 25) values.timeoutMs = value * 1000;
        afterChange(capability);
      });
      more.push(row('timeoutMs', '超时（秒，可留空）', seconds));
    }
  }
  nodes.push(el('div', {className: 'fields'}, ...basic));
  if (definition) {
    const state = [STATUS[definition.status], definition.note].filter(Boolean).join('。');
    const about = el('small', {className: 'hint', textContent: `${definition.label}：${state}`});
    // Nothing optional to set: only say how the service is called.
    if (!more.length) nodes.push(about);
    else {
      const details = el('details', {className: 'optional', id: 'more', open: moreOpen[capability] ?? customized(capability)},
        el('summary', {textContent: entry === 'custom' ? '更多设置（名称、鉴权、超时）' : '更多设置（地址、协议、参数）'}), el('div', {className: 'fields'}, ...more, about));
      details.addEventListener('toggle', () => { moreOpen[capability] = details.open; });
      nodes.push(details);
    }
    if (capability === 'tts') nodes.push($('voice-clone'));
    const listable = LISTABLE_KINDS.has(definition.kind) || LISTABLE_ENTRIES.has(entry);
    const test = el('button', {type: 'button', className: 'primary', id: 'check-run', dataset: {needsRun: ''},
      textContent: capability === 'tts' ? (services.reply === 'direct' ? '测试对话' : '试听') : '测试识别'});
    test.addEventListener('click', () => void runTest(capability));
    const read = listable ? el('button', {type: 'button', id: 'read-lists', dataset: {needsRun: ''}, textContent: capability === 'tts' ? '读取模型和音色列表' : '读取模型列表'}) : null;
    read?.addEventListener('click', () => void run('models', capability));
    const done = el('button', {type: 'button', id: 'editor-done', textContent: '完成'});
    done.addEventListener('click', () => toggleEditor(capability));
    const remove = el('button', {type: 'button', id: 'clear-capability', className: 'link', textContent: '停用这项能力'});
    remove.addEventListener('click', () => clearCapability(capability));
    nodes.push(el('div', {className: 'actions'}, test, read, done, remove));
  }
  nodes.push(el('small', {className: 'reason', id: 'editor-note', textContent: notes[capability] ?? ''}));
  box.replaceChildren(...nodes);
  updateAdvice(capability);
  gate();
}

function updateAdvice(capability) {
  const {entry, definition, profile: values} = active(capability);
  if (editing !== capability || !definition?.fields.includes('endpoint')) return;
  const advice = endpointAdvice(values.endpoint, {providerId: entry === 'custom' ? '' : entry, websocket: WEBSOCKET_KINDS.has(definition.kind),
    expected: entry === 'custom' ? '' : definition.defaults.endpoint});
  showAdvice('endpoint', advice.state === 'ok' ? null : advice);
}

function onFieldChange(capability, name) {
  if (['endpoint', 'auth'].includes(name)) { updateAdvice(capability); refreshSources(); }
  afterChange(capability);
}

// ---- service, interface and source ----

// Each (service, interface) keeps its own profile; a typed credential stays with the service it was typed for.
function chooseMethod(capability, entry, method, patch = {}) {
  const slot = services[capability], before = slot.entry, chosen = recognitionCapability();
  slot.entry = entry;
  slot.method = method;
  Object.assign(profileOf(capability), patch);
  delete pendingSource[capability];
  lists[capability] = {models: [], voices: []};
  readyClone = undefined;
  moreOpen[capability] = undefined;
  let note = before && before !== entry ? '已切换服务。每个服务的配置分别保存，切回时会恢复。' : '';
  // The first recognition service that gets configured is the one used for incoming voices.
  if (capability !== 'tts' && !before && (!chosen || !active(chosen).entry)) {
    services.recognition = capability === 'realtimeAsr' ? 'realtime' : 'file';
    note = `收到语音时将使用${CAPABILITIES[capability].label}，可以在下方更改。`;
  }
  afterChange(capability, note);
  renderEditor(capability);
  refreshSources();
}

function chooseEntry(capability, entry) {
  const slot = services[capability];
  const saved = Object.keys(slot.profiles).find(key => key.startsWith(entry + '/') && methodOf(entry, capability, key.slice(entry.length + 1)));
  const method = slot.entry === entry && slot.method ? slot.method : saved ? saved.slice(entry.length + 1) : Object.keys(methodsOf(entry, capability))[0];
  chooseMethod(capability, entry, method);
}

// Switching tabs keeps both drafts. A tab that already has a configured service brings it back with
// its values; an empty tab only shows its picker and leaves the current service in use.
function chooseSource(capability, source) {
  const slot = services[capability];
  if (slot.entry && (source === 'custom') === (slot.entry === 'custom')) {
    delete pendingSource[capability];
    return renderEditor(capability);
  }
  const last = Object.keys(slot.profiles).map(key => key.split('/')[0])
    .find(entry => (source === 'custom') === (entry === 'custom') && Object.keys(methodsOf(entry, capability)).length);
  if (last) return chooseEntry(capability, last);
  pendingSource[capability] = source;
  renderEditor(capability);
}

function clearCapability(capability) {
  const slot = services[capability];
  slot.entry = '';
  slot.method = '';
  delete pendingSource[capability];
  if (recognitionCapability() === capability) {
    const other = capability === 'realtimeAsr' ? 'fileAsr' : 'realtimeAsr';
    services.recognition = active(other).entry ? (other === 'realtimeAsr' ? 'realtime' : 'file') : 'off';
  }
  editing = null;
  afterChange(capability);
  renderEditor(capability);
}

// ---- recognition in use, authorization and advanced settings ----

function renderRecognition() {
  $('recognition').value = services.recognition;
  const capability = recognitionCapability();
  $('recognition-note').textContent = !capability ? '收到的语音不会转换成文字。'
    : active(capability).entry ? '每条语音只交给这一种识别。' : `「${CAPABILITIES[capability].label}」还没有配置，请先添加。`;
}

function authorizationGuide() {
  const permissions = ['“使用已配置的语音服务生成微信语音”'];
  if (services.recognition !== 'off' || services.reply === 'direct') permissions.push('“读取当前微信语音”');
  return `授权在本窗口上方修改：勾选“允许此插件运行”，在“授权能力与聊天”中勾选${permissions.join('和')}，并选择要使用语音的聊天。这里显示的是上次保存的授权。`;
}

function renderAuthorization() {
  const chats = info.chats ?? [];
  $('authorization-status').textContent = info.enabled ? `插件已启用，已授权 ${chats.length} 个聊天。` : '插件尚未启用，保存时请先勾选“允许此插件运行”。';
  $('authorization-chats').replaceChildren(...chats.slice(0, 50).map(chat => el('li', {textContent: chat.name && chat.name !== chat.key ? `${chat.name}（${chat.key}）` : chat.key})));
  $('authorization-guide').textContent = authorizationGuide();
}

function renderAdvanced() {
  const realtime = active('tts').definition?.kind === 'realtime-speak';
  $('reply-mode').value = services.reply;
  $('reply-mode').querySelector('option[value="direct"]').disabled = !realtime && services.reply !== 'direct';
  $('reply-hint').textContent = services.reply === 'direct' && !realtime
    ? '直接对话需要语音合成使用 Realtime 朗读，请改回“由 DSH 生成回复”或调整语音合成。'
    : '默认由 DSH 负责人格、上下文、回复正文和文字／语音的选择。直接对话只在语音合成使用 Realtime 朗读时可用。';
}

// ---- voice clone (shown when the speech synthesis interface supports it) ----

function cloneScope(settings) {
  const target = cloneTarget(settings.services);
  return target ? JSON.stringify([target.endpoint, target.model, typedOf('tts') ? 'typed:' + typedOf('tts') : 'saved']) : '';
}
function currentScope() { try { return cloneScope(values()); } catch { return ''; } }

function cloneGate() {
  const scope = editing === 'tts' ? currentScope() : '', voiceId = $('clone-id').value.trim();
  $('voice-clone').hidden = !scope;
  if (scope) $('clone-hint').textContent = `选择 10–20 秒的清晰单人录音（WAV、MP3、M4A，最大 7 MiB）。点击上传后，录音才会提交到当前语音合成服务的账号。复刻音色只绑定 ${cloneTarget(services)?.model}，审核就绪后才能使用。`;
  $('clone-create').disabled = !runAllowed || cloneBusy || busy || !scope || !$('clone-audio').files.length;
  $('clone-query').disabled = !runAllowed || cloneBusy || busy || !scope || !voiceId;
  $('clone-use').disabled = !runAllowed || cloneBusy || busy || !scope || readyClone?.scope !== scope || readyClone?.voiceId !== voiceId;
  $('clone-audio').disabled = $('clone-prefix').disabled = $('clone-id').disabled = cloneBusy;
}

function cloneStatus(message, failed = false) {
  $('clone-status').textContent = message;
  $('clone-status').className = failed ? 'error' : 'hint';
}

async function cloneRequest(create) {
  if (!runAllowed || cloneBusy || busy) return;
  let settings;
  try { settings = values(); } catch (error) { cloneStatus(error.message, true); return; }
  const scope = cloneScope(settings);
  if (!scope) return;
  const file = $('clone-audio').files[0], prefix = $('clone-prefix').value.trim();
  const format = file?.name.split('.').at(-1).toLowerCase();
  if (create && (!['wav', 'mp3', 'm4a'].includes(format) || file.size < 12 || file.size > cloneAudioLimit)) { cloneStatus('请选择 7 MiB 以内的 WAV、MP3 或 M4A 录音。', true); return; }
  if (create && !/^[A-Za-z0-9]{1,10}$/.test(prefix)) { cloneStatus('音色名称前缀需要 1–10 个英文字母或数字。', true); return; }
  let voiceId = $('clone-id').value.trim();
  if (!create && !voiceId) return;
  readyClone = undefined;
  cloneBusy = true;
  gate();
  try {
    if (create) {
      cloneStatus('正在上传录音并创建音色…');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('录音读取失败，请重新选择文件。'));
        reader.readAsDataURL(file);
      });
      if (!runAllowed || scope !== currentScope()) throw new Error('服务设置已变化，请重新提交录音。');
      const result = await wa.actions.call('clone-voice', {settings, prefix, format, base64: dataUrl.slice(dataUrl.indexOf(',') + 1)});
      if (!result.ok) throw new Error(result.message);
      voiceId = result.voiceId;
      $('clone-id').value = voiceId;
      $('clone-audio').value = '';
    }
    if (scope !== currentScope()) { cloneStatus('服务设置已变化。请切回创建音色时使用的账号、模型和服务地址，再查询状态。'); return; }
    cloneStatus('正在查询审核状态…');
    const result = await wa.actions.call('query-voice', {settings, voiceId});
    if (!result.ok) throw new Error(result.message);
    if (scope !== currentScope() || $('clone-id').value.trim() !== voiceId) { cloneStatus('设置或音色 ID 已变化，请重新查询。'); return; }
    if (result.status === 'OK') {
      readyClone = {scope, voiceId};
      cloneStatus('音色已就绪。点击“使用此音色”，然后试听并保存。');
    } else if (result.status === 'DEPLOYING') cloneStatus('音色正在审核。可复制此 ID，稍后粘贴并查询状态。');
    else cloneStatus('音色未通过审核，请核对录音后重新创建。', true);
  } catch (error) {
    cloneStatus(error.message, true);
  } finally {
    cloneBusy = false;
    gate();
  }
}

// ---- tests ----

// Buttons that call the plugin need "允许此插件运行" and no other request in flight.
function gate() {
  $('run-note').hidden = runAllowed;
  renderHeaders();
  for (const button of document.querySelectorAll('[data-needs-run]')) button.disabled = !runAllowed || busy || cloneBusy;
  cloneGate();
}

// A changed setting invalidates the capability's last test and any request still running.
function afterChange(capability, note = '') {
  generation++;
  busy = false;
  $('error').textContent = '';
  tests[capability] = undefined;
  notes[capability] = note;
  const line = $('editor-note');
  if (line && editing === capability) line.textContent = note;
  renderResult(capability);
  renderRecognition();
  renderAdvanced();
  $('authorization-guide').textContent = authorizationGuide();
  gate();
}

const FIELD_ALIASES = {realtimeEndpoint: 'endpoint', realtimeModel: 'model'};
function markFailure(capability, code, message) {
  const field = FAILURE_FIELDS[code];
  if (field && editing === capability) showAdvice(FIELD_ALIASES[field] ?? field, {state: 'error', message});
}

const runTest = capability => run(capability === 'tts' ? 'check' : 'check-input', capability);

async function run(action, capability) {
  if (!runAllowed || busy || cloneBusy || !active(capability).entry) return;
  const label = action === 'models' ? '连接' : action === 'check' ? '试听' : '识别结果';
  const show = () => { renderResult(capability); gate(); };
  let settings;
  try { settings = values(); }
  catch (error) { tests[capability] = {state: 'error', lines: [{label: '设置', text: error.message, state: 'error'}]}; show(); return; }
  const own = ++generation, previous = tests[capability]?.state === 'ok' ? 'ok' : null;
  busy = true;
  $('error').textContent = '';
  tests[capability] = {state: 'pending', lines: [{label, text: action === 'models' ? '正在连接…' : action === 'check' ? '正在生成…' : '正在识别内置录音…'}]};
  show();
  try {
    const extra = action === 'models' ? {capability} : action === 'check-input' ? {method: capability === 'realtimeAsr' ? 'realtime' : 'file'} : {};
    const response = await wa.actions.call(action, {settings, ...extra});
    if (own !== generation) return;
    if (!response.ok) {
      if (action === 'models' && response.code === 'VOICE_TTS_MODELS') {
        tests[capability] = {state: previous, lines: [{label, text: '已连接，但服务没有提供模型列表，请直接填写模型和音色 ID。', state: 'ok'}]};
        return;
      }
      markFailure(capability, response.code, response.message);
      throw new Error(response.message);
    }
    if (action === 'models') {
      lists[capability] = {models: response.models ?? [], voices: response.voices ?? []};
      const parts = [lists[capability].models.length ? `${lists[capability].models.length} 个模型` : '', lists[capability].voices.length ? `${lists[capability].voices.length} 个音色` : ''].filter(Boolean);
      tests[capability] = {state: previous, lines: [{label, text: parts.length ? '已连接，读取到 ' + parts.join('、') + '。' : '已连接，列表为空，请直接填写 ID。', state: 'ok'}]};
      if (editing === capability) renderEditor(capability);
    } else if (action === 'check-input') {
      tests[capability] = {state: 'ok', lines: [
        ...(response.partials?.length ? [{label: '中间结果', list: response.partials, state: 'ok'}] : []),
        {label, text: '“' + response.text + '”' + (capability === 'realtimeAsr' ? '（实际使用时只提交这段最终文字）' : ''), state: 'ok'}]};
    } else {
      const text = response.mode
        ? (response.mode === 'voice' ? '模型选择：语音。' : '模型选择：文字。') + '回复正文：“' + response.text + '”。' + (response.verified ? '' : '该平台的逐轮选择按协议实现，尚未经过供应商实测。')
        : response.clipped ? '语音生成成功，试听前 5 秒（试听音质较低，实际发送更清晰）。' : '语音生成成功（试听音质较低，实际发送更清晰）。';
      tests[capability] = {state: 'ok', lines: [{label, text, state: 'ok'}], preview: response.preview, autoplay: !!response.preview};
    }
  } catch (cause) {
    if (own !== generation) return;
    tests[capability] = {state: action === 'models' ? previous : 'error', lines: [{label, text: '失败：' + cause.message, state: 'error'}]};
  } finally {
    if (own === generation) { busy = false; show(); }
  }
}

// ---- startup ----

try {
  const [hostInfo, saved] = await Promise.all([wa.info(), wa.settings.get()]);
  info = hostInfo ?? {};
  stored = saved.values;
  const legacy = stored.services?.version !== 2;
  services = servicesOf(stored);
  $('capability-list').replaceChildren(...CAPABILITY_IDS.map(capability => el('div', {className: 'cap-row', dataset: {cap: capability}},
    el('div', {className: 'cap-head', id: 'head-' + capability}), el('div', {className: 'cap-result', id: 'result-' + capability, hidden: true}),
    el('div', {className: 'cap-editor', id: 'editor-' + capability, hidden: true}))));
  $('instructions').value = stored.instructions ?? '';
  $('timeout-seconds').value = String(Math.round((stored.timeoutMs ?? 20000) / 1000));
  if (legacy && CAPABILITY_IDS.some(capability => active(capability).entry)) {
    $('migration-note').hidden = false;
    $('migration-note').textContent = '已读取之前的配置。保存后按新格式写入；原有地址、模型、音色、密钥和授权保持不变。';
  }
  runAllowed = info.runAllowed === true;
  renderRecognition();
  renderAuthorization();
  renderAdvanced();
  gate();
  refreshSources();

  $('recognition').addEventListener('change', () => {
    services.recognition = $('recognition').value;
    generation++;
    busy = false;
    renderRecognition();
    $('authorization-guide').textContent = authorizationGuide();
    gate();
  });
  $('reply-mode').addEventListener('change', () => { services.reply = $('reply-mode').value === 'direct' ? 'direct' : 'dsh'; afterChange('tts'); if (editing === 'tts') renderEditor('tts'); });
  $('instructions').addEventListener('input', () => afterChange('tts'));
  $('timeout-seconds').addEventListener('input', () => showAdvice('timeoutMs', null));
  $('clone-audio').addEventListener('change', cloneGate);
  $('clone-id').addEventListener('input', cloneGate);
  $('clone-create').addEventListener('click', () => void cloneRequest(true));
  $('clone-query').addEventListener('click', () => void cloneRequest(false));
  $('clone-use').addEventListener('click', () => {
    cloneGate();
    if ($('clone-use').disabled) return;
    profileOf('tts').voice = readyClone.voiceId;
    cloneStatus('已填入音色。请试听，然后保存。');
    afterChange('tts', '已填入复刻音色。');
    renderEditor('tts');
  });
  wa.on('run-allowed', ({runAllowed: enabled} = {}) => { runAllowed = enabled === true; gate(); refreshSources(); });
  wa.onCollect(async ({enabled} = {}) => {
    if (cloneBusy) throw new Error('请等待当前音色请求完成。');
    generation++;
    busy = false;
    const settings = values();
    if (services.reply === 'direct' && active('tts').definition?.kind !== 'realtime-speak') throw new Error('直接对话需要语音合成使用 Realtime 朗读，请在高级设置中改回“由 DSH 生成回复”。');
    if (enabled) {
      const response = await wa.actions.call('validate', {settings});
      if (!response.ok) {
        const failing = CAPABILITY_IDS.find(capability => active(capability).entry && (missingCredential(capability) || tests[capability]?.state === 'error'));
        if (failing && editing !== failing) toggleEditor(failing);
        if (editing) markFailure(editing, response.code, response.message);
        throw new Error(response.message);
      }
    }
    return settings;
  });
} catch (cause) {
  $('error').textContent = cause.message;
}
