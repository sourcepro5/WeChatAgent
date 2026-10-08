export const MAX_PERSONA_BYTES = 60000;

export function personaError(name, content) {
  if (typeof name !== 'string' || !/^[^\\/\0.][^\\/\0]{0,60}$/.test(name) || name.includes('..') || /[<>:"|?*\r\n]/.test(name) || /[. ]$/.test(name) || /^README$/i.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
    return '请输入有效的人格名称，不含扩展名或文件路径；README 为保留名称。';
  }
  if (typeof content !== 'string' || !content.trim()) return '人格内容不能为空。';
  if (content.includes('\0')) return '人格内容包含无效字符，请选择 Markdown 文本文件。';
  if (new TextEncoder().encode(content).length > MAX_PERSONA_BYTES) return '人格内容最多 60 KB，请缩短后再保存。';
  return '';
}

export function decodePersonaFile(filename, bytes) {
  if (!/\.(md|markdown)$/i.test(filename)) throw new Error('请选择 .md 或 .markdown 人格文件。');
  if (bytes.byteLength > MAX_PERSONA_BYTES) throw new Error('人格文件最多 60 KB，请缩短后再导入。');
  const data = new Uint8Array(bytes);
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  let content;
  try { content = new TextDecoder(encoding, { fatal: true }).decode(data).replace(/^\uFEFF/, ''); }
  catch { throw new Error('无法读取文件编码，请另存为 UTF-8 Markdown 文件后导入。'); }
  const name = filename.replace(/\.(md|markdown)$/i, '').trim();
  // Invalid filenames can be corrected in the preview; malformed content cannot.
  const error = personaError('导入预览', content);
  if (error) throw new Error(error);
  return { name, content };
}
