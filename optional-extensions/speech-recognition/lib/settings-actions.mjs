import {speechFailureHelp} from './presets.mjs';
import {discoverModels,inspectConfiguration,probeTranscription,errorMessage} from './diagnostics.mjs';

// Settings-page actions (ui.json settings.actions). The host runs them in a
// short-lived worker with the saved settings in ctx.settings and no chat or
// host services. The page sends its unsaved draft; an empty secret keeps the
// saved value, and every result is stripped of those secrets.
export function draftSettings(ctx, draft, schema) {
  const settings = {...ctx.settings, ...draft};
  for (const [key, field] of Object.entries(schema)) if (field.secret && draft[key] === '' && ctx.settings[key]) settings[key] = ctx.settings[key];
  return settings;
}

export function redact(value, settings) {
  let text = JSON.stringify(value);
  const secrets = [settings.apiKey, settings.apiKey?.trim()];
  try { secrets.push(...Object.values(JSON.parse(settings.headersJson)).filter(item => typeof item === 'string' && item.length >= 6)); } catch {}
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[已隐藏]');
  return JSON.parse(text);
}

export function summary(report) {
  if (!report.configuration?.configurationValid) return {state: 'error', ready: false, label: '配置有误', message: report.configuration?.checks.find(item => item.state === 'error')?.message ?? '请检查接口配置。'};
  if (!report.configuration.decoderReady && !report.capabilities.checked) return {state: 'pending', ready: false, label: '运行环境待确认', message: report.capabilities.reason ?? '尚未确认 WAV 转换组件，请稍后重试。'};
  if (!report.configuration.decoderReady) return {state: 'error', ready: false, label: '转换组件未就绪', message: '当前微信语音还不能转换成所选上传格式。'};
  const probe = report.probe;
  if (probe?.verified === true && report.audioFormat === 'wav') return {state: 'ok', ready: true, label: '配置已验证', message: '内置短句转写成功，WAV 转换组件已就绪。'};
  if (probe?.verified === true) return {state: 'warning', ready: false, label: 'API 测试成功', message: 'WAV 测试短句已识别；实际 SILK 输入仍待验证。'};
  if (probe?.inconclusive) return {state: 'warning', ready: false, label: 'SILK 输入待验证', message: probe.message};
  if (probe && !probe.ok) return {state: 'error', ready: false, label: '识别测试失败', message: speechFailureHelp(probe.code) ?? probe.message};
  if (probe) return {state: 'warning', ready: false, label: '转写结果待确认', message: probe.message};
  if (report.models?.ok && !report.model) return {state: 'pending', ready: false, label: '已连接，待选模型', message: '请选择或填写一个语音识别模型，再点击测试识别。'};
  return {state: 'pending', ready: false, label: '待测试识别', message: report.models?.ok ? '读取模型不代表转写成功，请点击测试识别。' : report.models?.message ?? '请点击测试识别。'};
}

export function createSettingsActions(schema, {fetchImpl = fetch, now = Date.now} = {}) {
  const decoderOf = args => ({checked: args.decoder?.checked === true, decoder: args.decoder?.decoder === true, ...(typeof args.decoder?.reason === 'string' ? {reason: args.decoder.reason.slice(0, 200)} : {})});
  async function report(ctx, args, probe) {
    const settings = draftSettings(ctx, args.settings, schema), capabilities = decoderOf(args);
    const initial = inspectConfiguration(settings, capabilities);
    const [models, tested] = await Promise.all([
      discoverModels(settings, {signal: ctx.signal, fetchImpl}),
      probe && initial.configurationValid ? probeTranscription(settings, {signal: ctx.signal, fetchImpl}) : undefined,
    ]);
    const value = {checkedAt: now(), audioFormat: settings.audioFormat, model: settings.model.trim(), models, capabilities, configuration: inspectConfiguration(settings, capabilities, models.models)};
    if (tested) value.probe = {...tested, testedAt: now()};
    value.summary = summary(value);
    return redact(value, settings);
  }
  return {
    models: (ctx, args) => report(ctx, args, false),
    check: (ctx, args) => report(ctx, args, true),
    // Called by the page before enabling; never uses the network.
    validate(ctx, args) {
      const settings = draftSettings(ctx, args.settings, schema), result = inspectConfiguration(settings, decoderOf(args));
      const error = result.checks.find(item => item.state === 'error');
      return redact({ok: !error, ...(error ? {code: error.code, message: error.code ? errorMessage(error.code) : error.message} : {})}, settings);
    },
  };
}
