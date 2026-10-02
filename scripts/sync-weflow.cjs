const fs = require('node:fs');
const path = require('node:path');
async function verifyApi(file, { attempts = 20, delayMs = 300 } = {}) {
  let failure = 'WeFlow API not ready';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!config.reader_token) throw Error('Reader API token is missing; prepare the project configuration first.');
      const response = await fetch(`${config.reader_base_url}/api/v1/sessions?limit=1`, {
        headers: { Authorization: 'Bearer ' + config.reader_token }, signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (/读取组件已过期|expired: self-destruct/i.test(String(body.error ?? ''))) {
          const error = Error('WeFlow native database component has expired; install a valid upstream component.');
          error.permanent = true;
          throw error;
        }
        throw Error('WeFlow account/API status ' + response.status);
      }
      const body = await response.json();
      if (body.success === false) throw Error('WeFlow database is not connected yet.');
      return;
    } catch (error) { if (error.permanent) throw error; failure = error.message; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw Error(failure);
}
module.exports = { verifyApi };
if (require.main === module) {
  verifyApi(path.resolve(__dirname, '..', 'state', 'wechat-io-config.json'))
    .then(() => console.log('WeFlow primary-process API configuration verified.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
