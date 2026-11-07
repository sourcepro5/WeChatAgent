import fs from 'node:fs';
import path from 'node:path';

// Optional package-owned data, never HTML, JavaScript or an executable entry.
export function validateConfigUi(value, schema) {
  const invalid = () => { throw Error('插件页面说明无效，请检查 config-ui.json。'); };
  const text = (s, max = 160) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
  const keys = (object, allowed) => object && !Array.isArray(object) && typeof object === 'object' && Object.keys(object).every(key => allowed.includes(key));
  if (!keys(value, ['version', 'description', 'sections', 'fieldOptions']) || value.version !== 1 || value.description !== undefined && !text(value.description, 600)) invalid();
  if (!Array.isArray(value.sections) || !value.sections.length || value.sections.length > 8) invalid();
  const seen = new Set(), ids = new Set();
  for (const section of value.sections) {
    if (!keys(section, ['id', 'title', 'fields', 'advanced']) || !/^[a-z][a-z0-9-]{0,39}$/.test(section.id) || ids.has(section.id) || !text(section.title, 80) || section.advanced !== undefined && typeof section.advanced !== 'boolean' || !Array.isArray(section.fields) || section.fields.length > 24) invalid();
    ids.add(section.id);
    for (const key of section.fields) {
      if (typeof key !== 'string' || !Object.hasOwn(schema, key) || seen.has(key)) invalid();
      seen.add(key);
    }
  }
  if (!keys(value.fieldOptions ?? {}, Object.keys(schema))) invalid();
  for (const [key, options] of Object.entries(value.fieldOptions ?? {})) {
    if (!keys(options, ['label', 'help', 'placeholder', 'enumLabels'])) invalid();
    for (const name of ['label', 'help', 'placeholder']) if (options[name] !== undefined && !text(options[name], name === 'help' ? 600 : 160)) invalid();
    if (options.enumLabels !== undefined && (!schema[key].enum || !Array.isArray(options.enumLabels) || options.enumLabels.length !== schema[key].enum.length || options.enumLabels.some(s => !text(s, 100)))) invalid();
  }
  return structuredClone(value);
}

export function pluginConfigUi(root, item) {
  if (item.invalid) return {};
  const folder = path.join(root, 'plugins', item.id), file = path.join(folder, 'config-ui.json');
  try {
    for (const target of [path.join(root, 'plugins'), folder]) if (fs.lstatSync(target).isSymbolicLink()) throw Error();
    if (!fs.existsSync(file)) return {};
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw Error();
    return { configUi: validateConfigUi(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), item.configSchema) };
  } catch {
    return { configUiError: '插件页面说明不可用，已使用当前插件的标准配置表单。' };
  }
}
