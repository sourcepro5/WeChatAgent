import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './project-config.mjs';
const cache = path.join(projectRoot, 'state', 'installer-cache');
const runtime = path.join(projectRoot, 'state', 'installer-stage', 'runtime', 'python');
fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url, file, sha) {
  if (fs.existsSync(file) && hash(fs.readFileSync(file)) === sha) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) }); if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer()); if (hash(bytes) !== sha) throw new Error('SHA256 mismatch: ' + file);
  fs.writeFileSync(file, bytes);
}
function unpack(file, target) {
  const require = createRequire(path.join(projectRoot,'package.json'));
  const result = spawnSync(require('7zip-bin').path7za, ['x',file,'-o'+target,'-y'], {windowsHide:true,encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr || result.stdout || 'Archive extraction failed');
}

const archive = path.join(cache, 'python-3.13.16-embed-amd64.zip');
await download('https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip', archive, '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297');
unpack(archive, runtime);
const packages = [['sqlcipher3','0.6.2'],['cryptography','50.0.2'],['zstandard','0.25.0'],['pycryptodome','3.23.0'],['Pillow','12.3.0'],['imageio-ffmpeg','0.6.0'],['cffi','2.0.0'],['pycparser','2.23']];
const site = path.join(runtime, 'Lib', 'site-packages'); fs.mkdirSync(site, { recursive: true });
const locked = [];
for (const [name, version] of packages) {
  const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`); if (!response.ok) throw new Error('Dependency metadata unavailable: ' + name);
  const metadata = await response.json();
  const candidates = metadata.urls.filter(file => /-cp313-cp313-win_amd64\.whl$|-cp(?:37|39|311)-abi3-win_amd64\.whl$|-py3-none-(?:any|win_amd64)\.whl$/.test(file.filename));
  const wheel = candidates.find(file => /cp313-cp313/.test(file.filename)) ?? candidates[0];
  if (!wheel) throw new Error('No Python 3.13 Windows wheel: ' + name);
  const file = path.join(cache, wheel.filename); await download(wheel.url, file, wheel.digests.sha256); unpack(file, site);
  locked.push({ name, version, filename: wheel.filename, sha256: wheel.digests.sha256, url: wheel.url });
  console.log('Bundled Python dependency: ' + name + ' ' + version);
}
fs.writeFileSync(path.join(runtime, 'python313._pth'), 'python313.zip\n.\nLib/site-packages\nimport site\n');
fs.writeFileSync(path.join(runtime, 'DEPENDENCIES.json'), JSON.stringify(locked, null, 2));
const probe = spawnSync(path.join(runtime, 'python.exe'), ['-c', 'import sys,sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg; from sqlcipher3 import dbapi2; db=dbapi2.connect(":memory:"); db.execute("select 1").fetchone(); print("READER_RUNTIME_OK",sys.version.split()[0])'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
if (probe.status !== 0) throw new Error(probe.stderr || 'Bundled Python runtime failed');
console.log(probe.stdout.trim());
