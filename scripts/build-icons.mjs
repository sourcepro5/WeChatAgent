import fs from 'node:fs';
import path from 'node:path';

export async function buildIcons(root, output, sharp) {
  const source = fs.readFileSync(path.join(root, 'public/console/app-icon.png'));
  fs.mkdirSync(output, { recursive: true });
  await sharp(source).resize(256, 256, { fit: 'contain' }).ensureAlpha().png().toFile(path.join(output, 'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(size => sharp(source).resize(size, size, { fit: 'contain' }).ensureAlpha().png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const pos = 6 + i * 16;
    header[pos] = sizes[i] === 256 ? 0 : sizes[i]; header[pos + 1] = header[pos];
    header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(images[i].length, pos + 8); header.writeUInt32LE(offset, pos + 12);
    offset += images[i].length;
  }
  const file = path.join(output, 'icon.ico');
  fs.writeFileSync(file, Buffer.concat([header, ...images]));
  return file;
}

export function embedExecutableIcon(executable, iconFile, resedit) {
  const exe = resedit.NtExecutable.from(fs.readFileSync(executable), { ignoreCert: true });
  const resources = resedit.NtExecutableResource.from(exe);
  const icons = resedit.Data.IconFile.from(fs.readFileSync(iconFile)).icons.map(item => item.data);
  const groups = resources.entries.filter(entry => entry.type === 14).map(({ id, lang }) => ({ id, lang }));
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    resedit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
  }
  resources.outputResource(exe);
  const temp = executable + '.icon.tmp';
  fs.writeFileSync(temp, Buffer.from(exe.generate()));
  fs.renameSync(temp, executable);
}
