const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STRENGTH = 40;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_SAVED_BYTES = 6 * 1024 * 1024;
const strengthOf = value => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : DEFAULT_STRENGTH;

function createAppearanceStore(directory, nativeImage) {
  const imageFile = path.join(directory, 'background.png');
  function read(settings = {}) {
    let imageDataUrl = '';
    if (fs.existsSync(imageFile)) {
      const stat = fs.statSync(imageFile);
      if (stat.isFile() && stat.size <= MAX_SAVED_BYTES) {
        imageDataUrl = 'data:image/png;base64,' + fs.readFileSync(imageFile).toString('base64');
      }
    }
    return { imageDataUrl, name: imageDataUrl ? String(settings.name ?? '自定义背景').slice(0,160) : '', strength: strengthOf(settings.strength) };
  }
  async function importFile(file, settings = {}) {
    if (!/\.(png|jpe?g)$/i.test(file)) throw new Error('请选择 PNG 或 JPG 图片。');
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('请选择不超过 20 MB 的图片。');
    const bytes = await fs.promises.readFile(file);
    if (bytes.length > MAX_INPUT_BYTES) throw new Error('图片超过 20 MB，请换一张较小的图片。');
    let raster = nativeImage.createFromBuffer(bytes);
    if (raster.isEmpty()) throw new Error('无法读取这张图片，请尝试其他图片。');
    const size = raster.getSize();
    if (!size.width || !size.height || size.width * size.height > 48000000) throw new Error('图片尺寸过大，请使用不超过 4800 万像素的图片。');
    const fit = edge => {
      const current = raster.getSize(), longest = Math.max(current.width,current.height);
      if (longest > edge) raster = raster.resize({width:Math.max(1,Math.round(current.width*edge/longest)),height:Math.max(1,Math.round(current.height*edge/longest)),quality:'best'});
    };
    fit(2400);
    let png = raster.toPNG();
    if (png.length > MAX_SAVED_BYTES) { fit(1600); png = raster.toPNG(); }
    if (!png.length || png.length > MAX_SAVED_BYTES) throw new Error('图片内容过大，请换一张尺寸较小的图片。');
    fs.mkdirSync(directory,{recursive:true});
    const temp = imageFile + '.tmp'; await fs.promises.writeFile(temp,png); await fs.promises.rename(temp,imageFile);
    return { ...settings, name:path.basename(file), strength:strengthOf(settings.strength) };
  }
  function reset() { if (fs.existsSync(imageFile)) fs.unlinkSync(imageFile); }
  return { read, importFile, reset };
}
module.exports = { createAppearanceStore, strengthOf, DEFAULT_STRENGTH };
