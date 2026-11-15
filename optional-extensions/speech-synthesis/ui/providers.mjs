// Speech capabilities and their sources, shared by the settings page and the
// plugin runtime (no DOM, no network). Three capabilities are configured
// independently: speech synthesis (TTS), realtime (streaming) recognition and
// single-file recognition. Each one picks a third-party provider or a custom
// API, then one of that source's methods; every (source, method) pair keeps
// its own profile. Each capability owns one secret setting.

export const CAPABILITIES = Object.freeze({
  tts: {label: '语音合成', hint: '把文字转换成语音，可以选择音色和语速。回复需要以语音发出时使用。'},
  realtimeAsr: {label: '实时语音识别', hint: '以流式方式识别语音：边接收音频边返回中间结果，结束后给出最终文字。'},
  fileAsr: {label: '单条语音识别', hint: '把一段完整的录音提交给服务，识别完成后一次返回全部文字。'},
});
export const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITIES));
export const KEY_FIELDS = Object.freeze({tts: 'ttsKey', realtimeAsr: 'realtimeAsrKey', fileAsr: 'fileAsrKey'});
export const SECRET_FIELDS = Object.freeze(['apiKey', ...Object.values(KEY_FIELDS)]);
export const RECOGNITION = Object.freeze({realtime: '实时识别', file: '单条识别', off: '不识别'});

// Implementation states shown to the user. Only implemented methods
// (request, response parsing and audio conversion) can be selected.
export const STATUS = Object.freeze({
  tested: '已实现并通过测试',
  pending: '已实现、待真实凭据验证',
  custom: '按所填协议调用',
});

const QWEN_REALTIME = 'https://maas.qianwenaiapi.com/api-ws/v1/realtime';
const SF_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const list = rows => rows.map(([id, label]) => ({id, label}));
const QWEN_TTS_VOICES = list([['longanhuan_v3.1', '龙安欢（女）'], ['longanlingxin_v3.1', '龙安灵心（女）'], ['longanfengyue_v3.1', '龙安风悦（女）'],
  ['xunanchuan_v3.1', '许南川（男）'], ['yuxiaoyun_v3.1', '于小云（女）'], ['anxiaolan_v3.1', '安小岚（女）'], ['anmingyuan_v3.1', '安明远（男）'],
  ['longfeifei_v3.1', '龙菲菲（女）'], ['longxiaobai_v3.1', '龙小白'], ['loongbella_v3.1', 'Bella（中英）']]);
const QWEN_REALTIME_VOICES = list([['longanqian_v3.1', '默认音色'], ['longanlingxin_v3.1', '龙安灵心（女）'], ['longanhuan_v3.1', '龙安欢（女）'],
  ['longanfengyue_v3.1', '龙安风悦（女）'], ['xunanchuan_v3.1', '许南川（男）']]);
const TENCENT_VOICES = list([['502001', '智小柔 · 聊天女声（超自然大模型）'], ['502003', '智小敏 · 聊天女声（超自然大模型）'], ['502006', '智小悟 · 聊天男声（超自然大模型）'],
  ['501004', '月华 · 聊天女声（大模型）'], ['501005', '飞镜 · 聊天男声（大模型）'], ['402000', '云晓芙 · 聊天女声（超自然大模型 2.0）'],
  ['402002', '云大围 · 磁性男声（超自然大模型 2.0）'], ['101027', '智梅 · 通用女声（精品）'], ['101030', '智柯 · 通用男声（精品）']]);
const TENCENT_ENGINES = ['16k_zh', '16k_zh_en', '16k_zh-PY', '16k_zh_dialect', '16k_en', '16k_yue'];
const TENCENT_REALTIME_ENGINES = ['16k_zh', '16k_zh_en', '16k_zh-TW', '16k_en', '16k_yue'];

// Method kinds name the adapter that runs them:
//   TTS: openai-speech, realtime-speak, qwen-tts, tencent-tts, elevenlabs-tts, azure-tts, google-tts
//   realtime ASR: realtime-session, qwen-asr-realtime, openai-transcription, tencent-asr-ws
//   file ASR: openai-transcriptions, qwen-chat-asr, tencent-sentence, elevenlabs-stt, azure-stt, google-stt
// fields: profile values the user can change. defaults: the profile when the
// method is picked first. hosts: where the provider's credential may be sent.
export const PROVIDERS = Object.freeze([
  {
    id: 'qwen', name: '千问 / 阿里云百炼', region: '国内', keyLabel: 'API Key', keyKind: 'key',
    keyUrl: 'https://platform.qianwenai.com', hosts: ['.qianwenaiapi.com', '.aliyuncs.com'],
    consoleHosts: ['www.qianwenai.com', 'qianwenai.com', 'platform.qianwenai.com', 'bailian.console.aliyun.com', 'help.aliyun.com'],
    tip: '在千问 AI 平台创建 API Key。使用阿里云百炼业务空间时，地址可改为业务空间域名（密钥需属于同一平台）。',
    tts: {
      speech: {label: '语音合成（SpeechSynthesizer）', kind: 'qwen-tts', status: 'pending', clone: true,
        fields: ['endpoint', 'model', 'voice', 'speed'], models: ['qwen-audio-3.1-tts-flash', 'qwen-audio-3.1-tts-plus'], voices: QWEN_TTS_VOICES,
        defaults: {endpoint: 'https://maas.qianwenaiapi.com/api/v1', model: 'qwen-audio-3.1-tts-flash', voice: 'longanhuan_v3.1', speed: 1},
        note: '流式返回 16 kHz 音频，可调语速。音色需属于所选模型；复刻音色要以该模型为目标创建。'},
      realtime: {label: 'Realtime 朗读', kind: 'realtime-speak', status: 'tested', clone: true,
        fields: ['endpoint', 'model', 'voice'], models: ['qwen-audio-3.1-realtime-flash', 'qwen-audio-3.1-realtime-plus'], voices: QWEN_REALTIME_VOICES,
        defaults: {endpoint: QWEN_REALTIME, model: 'qwen-audio-3.1-realtime-flash', voice: 'longanqian_v3.1', protocol: 'auto'},
        note: 'Realtime 模型只逐字朗读 DSH 的正文，已在微信实发中确认送达。3.1 模型只能用带 _v3.1 的音色。'},
    },
    realtimeAsr: {
      session: {label: 'Realtime 会话转写（input_audio_transcription）', kind: 'realtime-session', status: 'tested',
        fields: ['endpoint', 'sessionModel', 'model'], models: ['fun-asr'], sessionModels: ['qwen-audio-3.1-realtime-flash', 'qwen-audio-3.1-realtime-plus'],
        defaults: {endpoint: QWEN_REALTIME, sessionModel: 'qwen-audio-3.1-realtime-flash', model: 'fun-asr', protocol: 'auto'},
        note: '在 Realtime 会话中指定转写模型（如 fun-asr），已在微信收到的真实语音上转写成功。'},
      asr: {label: '实时语音识别（Qwen-ASR-Realtime）', kind: 'qwen-asr-realtime', status: 'pending',
        fields: ['endpoint', 'model', 'language'], models: ['qwen3-asr-flash-realtime'],
        defaults: {endpoint: QWEN_REALTIME, model: 'qwen3-asr-flash-realtime', language: ''}},
    },
    fileAsr: {
      chat: {label: '录音文件识别（/chat/completions）', kind: 'qwen-chat-asr', status: 'pending',
        fields: ['endpoint', 'model', 'language'], models: ['qwen3-asr-flash'],
        defaults: {endpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen3-asr-flash', language: ''},
        note: '音频以 Base64 Data URL 提交到 /chat/completions，单条最长 5 分钟、10 MB。'},
    },
  },
  {
    id: 'tencent', name: '腾讯云语音', region: '国内', keyLabel: 'SecretId / SecretKey', keyKind: 'tencent',
    keyUrl: 'https://console.cloud.tencent.com/cam/capi', hosts: ['tts.tencentcloudapi.com', 'asr.tencentcloudapi.com', 'asr.cloud.tencent.com'],
    consoleHosts: ['console.cloud.tencent.com', 'cloud.tencent.com'],
    tip: '在腾讯云“访问管理 → API 密钥管理”创建 SecretId 和 SecretKey，并开通语音合成、语音识别。',
    tts: {
      tc: {label: '语音合成（TextToVoice）', kind: 'tencent-tts', status: 'pending', fields: ['voice', 'speed', 'region'], voices: TENCENT_VOICES,
        regions: ['', 'ap-beijing', 'ap-shanghai', 'ap-guangzhou', 'ap-chengdu', 'ap-nanjing', 'ap-hongkong', 'ap-singapore'],
        defaults: {voice: '502001', speed: 1, region: ''}, note: '单次最多 150 个汉字，较长的正文按句分段合成后拼接。'},
    },
    realtimeAsr: {
      ws: {label: '实时语音识别（WebSocket）', kind: 'tencent-asr-ws', status: 'pending', fields: ['appId', 'model'], models: TENCENT_REALTIME_ENGINES,
        defaults: {appId: '', model: '16k_zh'},
        note: '需要账号 APPID。服务端每秒最多接收 3 秒音频，插件按 2.5 倍速分段发送，60 秒的语音约 24 秒发完。'},
    },
    fileAsr: {
      sentence: {label: '录音文件识别（SentenceRecognition）', kind: 'tencent-sentence', status: 'pending', fields: ['model'], models: TENCENT_ENGINES,
        defaults: {model: '16k_zh'}, note: '60 秒、3 MB 以内。'},
    },
  },
  {
    id: 'openai', name: 'OpenAI', region: '海外', keyLabel: 'API Key', keyKind: 'key',
    keyUrl: 'https://platform.openai.com/api-keys', hosts: ['api.openai.com'],
    consoleHosts: ['platform.openai.com', 'openai.com', 'www.openai.com', 'chatgpt.com'], listable: true,
    tip: '国内网络通常无法直接访问。使用 OpenAI 官方语音时，请告知听众语音由 AI 生成。',
    tts: {
      speech: {label: '语音合成（/audio/speech）', kind: 'openai-speech', status: 'pending', fields: ['model', 'voice', 'speed'],
        models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], voices: OPENAI_VOICES.map(id => ({id, label: id})),
        defaults: {endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'marin', speed: 1}},
      realtime: {label: 'Realtime 朗读', kind: 'realtime-speak', status: 'pending', fields: ['model', 'voice'], note: 'Realtime 模型只逐字朗读 DSH 的正文。',
        models: ['gpt-realtime-2.1-mini'], voices: OPENAI_VOICES.slice(0, 10).map(id => ({id, label: id})),
        defaults: {endpoint: 'https://api.openai.com/v1', model: 'gpt-realtime-2.1-mini', voice: 'marin', protocol: 'auto'}},
    },
    realtimeAsr: {
      transcription: {label: '实时语音识别（Realtime 转写会话）', kind: 'openai-transcription', status: 'pending', fields: ['model', 'language'],
        models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'], defaults: {endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', language: ''}},
    },
    fileAsr: {
      transcriptions: {label: '录音文件识别（/audio/transcriptions）', kind: 'openai-transcriptions', status: 'pending', fields: ['model'],
        models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], defaults: {endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe'}},
    },
  },
  {
    id: 'siliconflow', name: '硅基流动 SiliconFlow', region: '国内', keyLabel: 'API Key', keyKind: 'key',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak', hosts: ['api.siliconflow.cn', 'api.siliconflow.com'], listable: true,
    consoleHosts: ['cloud.siliconflow.cn', 'siliconflow.cn', 'www.siliconflow.cn', 'docs.siliconflow.cn', 'cloud.siliconflow.com', 'www.siliconflow.com'],
    tip: '国内可直接访问，支持中文。',
    tts: {
      speech: {label: '语音合成（/audio/speech）', kind: 'openai-speech', status: 'pending', fields: ['model', 'voice', 'speed'], models: [SF_MODEL],
        voices: [['claire', '温柔女声'], ['anna', '沉稳女声'], ['bella', '激情女声'], ['diana', '欢快女声'],
          ['alex', '沉稳男声'], ['benjamin', '低沉男声'], ['charles', '磁性男声'], ['david', '欢快男声']].map(([id, label]) => ({id: SF_MODEL + ':' + id, label})),
        defaults: {endpoint: 'https://api.siliconflow.cn/v1', model: SF_MODEL, voice: SF_MODEL + ':claire', speed: 1}},
    },
    fileAsr: {
      transcriptions: {label: '录音文件识别（/audio/transcriptions）', kind: 'openai-transcriptions', status: 'pending', fields: ['model'],
        models: ['FunAudioLLM/SenseVoiceSmall'], defaults: {endpoint: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall'}},
    },
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', region: '海外', keyLabel: 'API Key', keyKind: 'key',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys', hosts: ['api.elevenlabs.io'], consoleHosts: ['elevenlabs.io', 'www.elevenlabs.io'], listable: true,
    tip: '可以从账号读取音色和模型列表。即时声音克隆暂未接入，可在 ElevenLabs 创建后填写音色 ID。',
    tts: {
      tts: {label: '语音合成（Text to Speech）', kind: 'elevenlabs-tts', status: 'pending', fields: ['model', 'voice', 'speed'],
        models: ['eleven_multilingual_v2'], voices: list([['JBFqnCBsd6RMkjVDRZzb', '官方示例音色']]),
        defaults: {model: 'eleven_multilingual_v2', voice: 'JBFqnCBsd6RMkjVDRZzb', speed: 1}, note: '输出 wav_16000，语速范围 0.7–1.2。'},
    },
    fileAsr: {stt: {label: '录音文件识别（Speech to Text）', kind: 'elevenlabs-stt', status: 'pending', fields: ['model'], models: ['scribe_v2'], defaults: {model: 'scribe_v2'}}},
  },
  {
    id: 'azure', name: 'Azure AI Speech', region: '海外', keyLabel: '资源密钥', keyKind: 'key', keyUrl: 'https://portal.azure.com',
    hosts: ['.tts.speech.microsoft.com', '.stt.speech.microsoft.com'], consoleHosts: ['portal.azure.com', 'learn.microsoft.com', 'speech.microsoft.com'], listable: true,
    tip: '在 Azure 门户的语音资源“密钥和终结点”中复制密钥和区域，区域需与资源一致。',
    tts: {
      tts: {label: '语音合成（REST）', kind: 'azure-tts', status: 'pending', fields: ['region', 'voice', 'speed'],
        regions: ['eastasia', 'southeastasia', 'japaneast', 'eastus', 'westus2', 'westeurope'],
        voices: list([['zh-CN-XiaoxiaoNeural', '晓晓（女）'], ['zh-CN-XiaoyiNeural', '晓伊（女）'], ['zh-CN-XiaochenNeural', '晓辰（女）'],
          ['zh-CN-YunxiNeural', '云希（男）'], ['zh-CN-YunjianNeural', '云健（男）'], ['zh-CN-YunyangNeural', '云扬（男）']]),
        defaults: {region: 'eastasia', voice: 'zh-CN-XiaoxiaoNeural', speed: 1}},
    },
    fileAsr: {
      stt: {label: '录音文件识别（短音频 REST，60 秒以内）', kind: 'azure-stt', status: 'pending', fields: ['region', 'model'],
        regions: ['eastasia', 'southeastasia', 'japaneast', 'eastus', 'westus2', 'westeurope'], models: ['zh-CN', 'en-US', 'zh-HK', 'zh-TW'],
        defaults: {region: 'eastasia', model: 'zh-CN'}},
    },
  },
  {
    id: 'google', name: 'Google Cloud Speech', region: '海外', keyLabel: '服务账号 JSON', keyKind: 'google',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts', hosts: ['oauth2.googleapis.com', 'texttospeech.googleapis.com', 'speech.googleapis.com'],
    consoleHosts: ['console.cloud.google.com', 'cloud.google.com', 'docs.cloud.google.com'], listable: true,
    tip: '启用 Text-to-Speech 与 Speech-to-Text API，为服务账号创建 JSON 密钥。JSON 只保存在本机插件设置中，页面不会回显。',
    tts: {
      tts: {label: '语音合成（Text-to-Speech）', kind: 'google-tts', status: 'pending', fields: ['voice', 'speed'],
        voices: list([['cmn-CN-Wavenet-A', 'Wavenet A（女）'], ['cmn-CN-Wavenet-B', 'Wavenet B（男）'], ['cmn-CN-Wavenet-C', 'Wavenet C（男）'],
          ['cmn-CN-Wavenet-D', 'Wavenet D（女）'], ['cmn-CN-Standard-A', 'Standard A（女）'], ['cmn-CN-Standard-B', 'Standard B（男）']]),
        defaults: {voice: 'cmn-CN-Wavenet-A', speed: 1}},
    },
    fileAsr: {stt: {label: '录音文件识别（Speech-to-Text v1）', kind: 'google-stt', status: 'pending', fields: ['model'], models: ['cmn-Hans-CN', 'en-US', 'yue-Hant-HK'], defaults: {model: 'cmn-Hans-CN'}}},
  },
  {
    id: 'glm', name: '智谱 GLM-Realtime', region: '国内', keyLabel: 'API Key', keyKind: 'key', keyUrl: 'https://bigmodel.cn',
    hosts: ['.bigmodel.cn'], consoleHosts: ['bigmodel.cn', 'www.bigmodel.cn', 'docs.bigmodel.cn'], tip: '在智谱开放平台（bigmodel.cn）创建 API Key。',
    tts: {
      realtime: {label: 'Realtime 朗读', kind: 'realtime-speak', status: 'pending', fields: ['model', 'voice'], note: 'Realtime 模型只逐字朗读 DSH 的正文。', models: ['glm-realtime-flash', 'glm-realtime-air'],
        voices: list([['tongtong', '通用女声'], ['xiaochen', '通用男声'], ['female-tianmei', '甜美女性'], ['female-shaonv', '少女'],
          ['male-qn-daxuesheng', '青年大学生'], ['male-qn-jingying', '精英青年'], ['lovely_girl', '萌萌女童']]),
        defaults: {endpoint: 'https://open.bigmodel.cn/api/paas/v4/realtime', model: 'glm-realtime-flash', voice: 'tongtong', protocol: 'auto'}},
    },
  },
  {
    id: 'stepfun', name: '阶跃星辰 StepAudio', region: '国内', keyLabel: 'API Key', keyKind: 'key', keyUrl: 'https://platform.stepfun.com',
    hosts: ['api.stepfun.com'], consoleHosts: ['platform.stepfun.com', 'stepfun.com', 'www.stepfun.com'], tip: '在阶跃星辰开放平台创建 API Key。',
    tts: {
      realtime: {label: 'Realtime 朗读', kind: 'realtime-speak', status: 'pending', fields: ['model', 'voice'], note: 'Realtime 模型只逐字朗读 DSH 的正文。',
        models: ['stepaudio-2.5-realtime', 'step-audio-2', 'step-audio-2-mini'], voices: list([['linjiajiejie', 'linjiajiejie']]),
        defaults: {endpoint: 'https://api.stepfun.com/v1/realtime', model: 'stepaudio-2.5-realtime', voice: 'linjiajiejie', protocol: 'auto'}},
    },
  },
]);

// Custom APIs: one protocol per method, for local services and gateways.
const CUSTOM_COMMON = ['name', 'endpoint', 'auth', 'timeoutMs'];
export const CUSTOM = Object.freeze({
  id: 'custom', name: '自定义模型 API', keyKind: 'key', keyLabel: '密钥',
  tts: {
    speech: {label: '语音合成（OpenAI 兼容 /audio/speech）', kind: 'openai-speech', status: 'custom', fields: [...CUSTOM_COMMON, 'model', 'voice', 'speed'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', model: '', voice: '', speed: 1}},
    realtime: {label: 'Realtime 朗读（WebSocket，OpenAI 正式版或测试版事件）', kind: 'realtime-speak', status: 'custom', fields: [...CUSTOM_COMMON, 'protocol', 'model', 'voice'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', protocol: 'auto', model: '', voice: ''}},
  },
  realtimeAsr: {
    transcription: {label: '实时语音识别（Realtime 转写会话，OpenAI 格式）', kind: 'openai-transcription', status: 'custom', fields: [...CUSTOM_COMMON, 'model', 'language'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', model: '', language: ''}},
    asr: {label: '实时语音识别（DashScope 格式，text + stash 中间结果）', kind: 'qwen-asr-realtime', status: 'custom', fields: [...CUSTOM_COMMON, 'model', 'language'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', model: '', language: ''}},
    session: {label: 'Realtime 会话转写（input_audio_transcription）', kind: 'realtime-session', status: 'custom',
      fields: [...CUSTOM_COMMON, 'protocol', 'sessionModel', 'model'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', protocol: 'auto', sessionModel: '', model: ''}},
  },
  fileAsr: {
    transcriptions: {label: '录音文件识别（OpenAI 兼容 /audio/transcriptions）', kind: 'openai-transcriptions', status: 'custom', fields: [...CUSTOM_COMMON, 'model'],
      defaults: {name: '', endpoint: '', auth: 'bearer', authHeader: '', model: ''}},
  },
});
export const AUTH_MODES = Object.freeze({bearer: 'Authorization: Bearer 密钥', header: '自定义请求头', none: '无需鉴权'});
// Realtime WebSockets can only carry a Bearer header (or nothing).
export const WEBSOCKET_KINDS = new Set(['realtime-speak', 'realtime-session', 'qwen-asr-realtime', 'openai-transcription', 'tencent-asr-ws']);

export const providerById = id => PROVIDERS.find(item => item.id === id);
export const entryById = id => id === 'custom' ? CUSTOM : providerById(id);
export const methodsOf = (entry, capability) => entryById(entry)?.[capability] ?? {};
export const methodOf = (entry, capability, method) => methodsOf(entry, capability)[method];
export const providersFor = capability => PROVIDERS.filter(item => Object.keys(item[capability] ?? {}).length);
export const usable = status => ['tested', 'pending', 'custom'].includes(status);

const hostOf = value => { try { return new URL(String(value ?? '').trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
const hostMatches = (rule, host) => rule.startsWith('.') ? host === rule.slice(1) || host.endsWith(rule) : rule === host;
export const providerHostAllowed = (item, url) => {
  const host = hostOf(url);
  return !!host && (item?.hosts ?? []).some(rule => hostMatches(rule, host));
};
export const providerForHost = value => { const host = hostOf(value); return host ? PROVIDERS.find(item => item.hosts.some(rule => hostMatches(rule, host))) : undefined; };
// The scheme+host+port a custom credential may be sent to; WebSocket addresses
// map to their HTTP origin so one gateway serves both.
export function originOf(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { return ''; }
  const protocol = {'wss:': 'https:', 'ws:': 'http:'}[url.protocol] ?? url.protocol;
  if (!['https:', 'http:'].includes(protocol) || !url.hostname) return '';
  return protocol + '//' + url.host.toLowerCase();
}
export const originsOf = addresses => [...new Set(addresses.map(originOf).filter(Boolean))].sort();

export const profileKey = (entry, method) => entry + '/' + method;

// A fresh profile for a method; custom profiles start empty.
export function defaultProfile(capability, entry, method) {
  const definition = methodOf(entry, capability, method);
  return definition ? structuredClone(definition.defaults) : {};
}

// The active (entry, method, profile) of a capability; empty when unset.
export function activeOf(services, capability) {
  const slot = services?.[capability];
  const entry = slot?.entry ?? '', method = slot?.method ?? '';
  const definition = methodOf(entry, capability, method);
  if (!definition) return {entry: '', method: '', definition: undefined, profile: {}};
  const profile = {...definition.defaults, ...slot.profiles?.[profileKey(entry, method)]};
  // Providers without an editable address always use their own.
  if (entry !== 'custom' && !definition.fields.includes('endpoint') && definition.defaults.endpoint) profile.endpoint = definition.defaults.endpoint;
  return {entry, method, definition, profile};
}

// Addresses a capability's requests go to, for credential checks. Providers
// with fixed hosts (Tencent, ElevenLabs, Azure, Google) are not listed here.
export function addressesOf(capability, active) {
  const {entry, definition, profile} = active;
  if (!definition) return [];
  const editable = entry === 'custom' || ['openai-speech', 'openai-transcriptions', 'realtime-speak', 'realtime-session', 'qwen-asr-realtime',
    'openai-transcription', 'qwen-tts', 'qwen-chat-asr'].includes(definition.kind);
  return editable ? [String(profile.endpoint ?? '').trim()].filter(Boolean) : [];
}

// ---- migration ----

const LEGACY_KEYS = ['endpoint', 'model', 'voice', 'speed', 'recognitionModel', 'recognitionEndpoint', 'realtimeModel', 'realtimeEndpoint', 'realtimeProtocol'];
const legacyFlat = settings => Object.fromEntries(LEGACY_KEYS.map(key => [key, settings[key] ?? (key === 'speed' ? 1 : key === 'realtimeProtocol' ? 'auto' : '')]));
const legacyAddresses = flat => ['endpoint', 'recognitionEndpoint', 'realtimeEndpoint'].map(key => String(flat[key] ?? '').trim()).filter(Boolean);
const LEGACY_PROVIDERS = ['qwen', 'openai', 'siliconflow', 'glm', 'stepfun'];
const CLOUD_PROVIDERS = ['tencent', 'elevenlabs', 'azure', 'google'];

// 1.5.0 saved one active entry with one flat profile; earlier versions only
// the flat fields. Either way: one entry, one profile, one legacy key owner.
function legacySource(settings) {
  const saved = settings.services;
  if (saved?.version === 1) {
    const entry = saved.source === 'custom' ? 'custom' : saved.source === 'provider' ? saved.provider : '';
    const profile = {...legacyFlat(settings), ...saved.profiles?.[entry]};
    const owner = saved.legacyKey === 'custom' ? {entry: 'custom', origins: [...(saved.keyOrigins?.custom ?? [])].sort()}
      : saved.legacyKey ? {entry: saved.legacyKey} : null;
    return {entry: providerById(entry) || entry === 'custom' ? entry : '', profile, owner};
  }
  const flat = legacyFlat(settings), urls = legacyAddresses(flat);
  if (!urls.length) return {entry: '', profile: flat, owner: null};
  const provider = LEGACY_PROVIDERS.map(providerById).find(item => urls.every(url => providerHostAllowed(item, url)));
  if (provider) return {entry: provider.id, profile: flat, owner: {entry: provider.id}};
  return {entry: 'custom', profile: flat, owner: {entry: 'custom', origins: originsOf(urls)}};
}

export function emptyServices() {
  return {version: 2, recognition: 'off', reply: 'dsh', tts: emptySlot(), realtimeAsr: emptySlot(), fileAsr: emptySlot(),
    owners: {tts: null, realtimeAsr: null, fileAsr: null}, legacy: null};
}
const emptySlot = () => ({entry: '', method: '', profiles: {}});

// The deterministic v2 view of settings saved before 1.6.0. Existing
// addresses, models, voices (including cloned voices), recognition model,
// speed, protocol and reply mode are kept; the legacy apiKey stays with the
// entry it was used for.
export function migrateServices(settings = {}) {
  const {entry, profile: flat, owner} = legacySource(settings);
  const services = emptyServices();
  services.legacy = owner;
  const mode = settings.voiceMode || 'separate';
  services.reply = mode === 'realtime' ? 'direct' : 'dsh';
  if (!entry) return services;
  const custom = entry === 'custom', auth = custom ? {auth: flat.auth ?? 'bearer', authHeader: flat.authHeader ?? ''} : {};
  const set = (capability, method, profile, source = entry) => {
    services[capability] = {entry: source, method, profiles: {[profileKey(source, method)]: {...defaultProfile(capability, source, method), ...profile}}};
  };
  const realtimeAddress = flat.realtimeEndpoint || flat.endpoint;
  if (mode !== 'separate' && methodOf(entry, 'tts', 'realtime')) {
    set('tts', 'realtime', {endpoint: realtimeAddress, model: flat.realtimeModel, voice: flat.voice, protocol: flat.realtimeProtocol || 'auto', ...auth});
  } else if (mode === 'separate' && (flat.model || flat.voice)) {
    const method = custom ? 'speech' : Object.keys(methodsOf(entry, 'tts'))[0];
    if (methodOf(entry, 'tts', method)) set('tts', method, {...(CLOUD_PROVIDERS.includes(entry) ? {} : {endpoint: flat.endpoint}),
      model: flat.model, voice: flat.voice, speed: flat.speed ?? 1, ...(flat.region ? {region: flat.region} : {}), ...auth});
  }
  if (String(flat.recognitionModel ?? '').trim()) {
    if (mode === 'dsh-realtime' && !flat.recognitionEndpoint && methodOf(entry, 'realtimeAsr', 'session')) {
      set('realtimeAsr', 'session', {endpoint: realtimeAddress, sessionModel: flat.realtimeModel, model: flat.recognitionModel, protocol: flat.realtimeProtocol || 'auto', ...auth});
      services.recognition = 'realtime';
    } else {
      const method = custom ? 'transcriptions' : CLOUD_PROVIDERS.includes(entry) ? Object.keys(methodsOf(entry, 'fileAsr'))[0]
        : methodOf(entry, 'fileAsr', 'transcriptions') ? 'transcriptions' : '';
      if (method) {
        set('fileAsr', method, {...(CLOUD_PROVIDERS.includes(entry) ? {} : {endpoint: flat.recognitionEndpoint || flat.endpoint}),
          model: flat.recognitionModel, ...(flat.region ? {region: flat.region} : {}), ...auth});
        services.recognition = 'file';
      } else if (flat.recognitionEndpoint) {
        // A Realtime-only provider with a separate transcription address: that
        // address is a custom service of its own.
        set('fileAsr', 'transcriptions', {endpoint: flat.recognitionEndpoint, model: flat.recognitionModel}, 'custom');
        services.recognition = 'file';
      }
    }
  }
  return services;
}

// One field order for saved and migrated services, so equal content compares equal.
export function normalizeServices(value = {}) {
  const slot = saved => ({entry: saved?.entry ?? '', method: saved?.method ?? '', profiles: {...saved?.profiles}});
  return {version: 2, recognition: Object.hasOwn(RECOGNITION, value.recognition) ? value.recognition : 'off', reply: value.reply === 'direct' ? 'direct' : 'dsh',
    tts: slot(value.tts), realtimeAsr: slot(value.realtimeAsr), fileAsr: slot(value.fileAsr),
    owners: {tts: value.owners?.tts ?? null, realtimeAsr: value.owners?.realtimeAsr ?? null, fileAsr: value.owners?.fileAsr ?? null},
    legacy: value.legacy ?? null};
}

// Saved v2 services, or the migrated view of older settings.
export function servicesOf(settings = {}) {
  return settings.services?.version === 2 ? normalizeServices(settings.services) : migrateServices(settings);
}

// ---- credentials ----

// The owner record for a credential typed for a capability's active source.
export function ownerFor(capability, active) {
  if (!active.entry) return null;
  return active.entry === 'custom' ? {entry: 'custom', origins: originsOf(addressesOf(capability, active))} : {entry: active.entry};
}

// Whether an owner record covers a capability's active source and addresses.
export function ownerMatches(owner, active, capability) {
  if (!owner || !active.entry || owner.entry !== active.entry) return false;
  if (active.entry !== 'custom') return true;
  const bound = owner.origins ?? [];
  const needed = originsOf(addressesOf(capability, active));
  return needed.length > 0 && needed.every(origin => bound.includes(origin));
}

// The credential a capability uses: its own slot, another capability's slot
// owned by the same source, or the legacy apiKey. Never a key owned elsewhere.
export function credentialOf(settings, capability, services = servicesOf(settings)) {
  const active = activeOf(services, capability);
  if (!active.entry) return {key: '', from: ''};
  if (active.entry === 'custom' && active.profile.auth === 'none') return {key: '', from: 'none'};
  for (const slot of [capability, ...CAPABILITY_IDS.filter(other => other !== capability)]) {
    const key = String(settings[KEY_FIELDS[slot]] ?? '').trim();
    if (key && ownerMatches(services.owners[slot], active, capability)) return {key, from: slot};
  }
  const legacy = String(settings.apiKey ?? '').trim();
  if (legacy && ownerMatches(services.legacy, active, capability)) return {key: legacy, from: 'legacy'};
  return {key: '', from: ''};
}

// ---- values the host reads ----

// voiceMode and recognitionModel are read by the host to decide which voice
// features this plugin serves; they are derived from the services.
export function hostSettings(services) {
  const tts = activeOf(services, 'tts');
  const realtime = tts.definition?.kind === 'realtime-speak';
  const voiceMode = services.reply === 'direct' && realtime ? 'realtime' : realtime ? 'dsh-realtime' : 'separate';
  let recognitionModel = '';
  if (voiceMode !== 'realtime' && services.recognition !== 'off') {
    const asr = activeOf(services, services.recognition === 'realtime' ? 'realtimeAsr' : 'fileAsr');
    if (asr.definition) recognitionModel = String(asr.profile.model || asr.method).trim().slice(0, 200);
  }
  return {voiceMode, recognitionModel};
}
