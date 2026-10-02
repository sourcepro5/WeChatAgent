const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyApi } = require('./sync-weflow.cjs');

test('startup waits for the database and uses primary-process API settings', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent-api-test-'));
  let requests = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.writeHead(++requests < 3 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: requests >= 3 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const file = path.join(directory, 'wechat-io.json');
    fs.writeFileSync(file, JSON.stringify({ reader_token: 'fixture-token', reader_base_url: `http://127.0.0.1:${server.address().port}` }));
    await verifyApi(file, { attempts: 4, delayMs: 5 });
    assert.equal(requests, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
