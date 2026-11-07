import fs from 'node:fs';
import {recognize} from './lib/recognize.mjs';
import {createSettingsActions} from './lib/settings-actions.mjs';

const {configSchema} = JSON.parse(fs.readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));

export function setup(api) {
  api.registerAction({
    id: 'transcribe',
    description: '转写宿主核验过的当前微信语音；接口和密钥完全由本机配置。',
    parameters: {
      type: 'object', properties: {id: {type: 'string', minLength: 64, maxLength: 64}},
      required: ['id'], additionalProperties: false,
    },
    execute: recognize,
  });
  // Used only by ui/settings.html (declared in ui.json settings.actions). The
  // draft settings follow the package schema; the host's voice decoder facts
  // come from wa.info() because the page cannot reach the host itself.
  const settings = createSettingsActions(configSchema);
  const parameters = {
    type: 'object',
    properties: {
      settings: {type: 'object', properties: configSchema, additionalProperties: false},
      decoder: {type: 'object', properties: {checked: {type: 'boolean'}, decoder: {type: 'boolean'}, reason: {type: 'string', maxLength: 200}}, additionalProperties: false},
    },
    required: ['settings'], additionalProperties: false,
  };
  api.registerAction({id: 'models', description: '设置页读取模型列表并检查配置，不上传语音。', parameters, execute: settings.models});
  api.registerAction({id: 'check', description: '设置页用内置短句测试识别，可能使用服务商额度。', parameters, execute: settings.check});
  api.registerAction({id: 'validate', description: '设置页启用前检查配置格式，不联网。', parameters, execute: settings.validate});
}
