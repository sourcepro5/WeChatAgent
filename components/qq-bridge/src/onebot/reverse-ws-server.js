import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024;

function frame(opcode, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
    : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
      : Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0,
        (body.length / 0x1000000) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]);
  return Buffer.concat([header, body]);
}

export class ReverseOneBotServer extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 11229, path = '/ws', token = '', timeoutMs = 10000 } = {}) {
    super();
    this.config = { host, port, path, token, timeoutMs };
    this.server = null;
    this.socket = null;
    this.pending = new Map();
    this.connected = false;
  }

  async start() {
    if (this.server) return;
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.config.host) && !this.config.token) {
      throw new Error('non-loopback OneBot listener requires a token');
    }
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => {
      const { path, token } = this.config;
      const reject = (code) => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
      if (req.url !== path || req.headers.upgrade?.toLowerCase() !== 'websocket'
        || req.headers['sec-websocket-version'] !== '13' || this.socket) return reject('400 Bad Request');
      if (token) {
        const supplied = req.headers.authorization?.replace(/^Bearer /i, '') ?? '';
        const a = Buffer.from(supplied); const b = Buffer.from(token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reject('401 Unauthorized');
      }
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return reject('400 Bad Request');
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      this.socket = socket; this.connected = true; this.emit('open');
      let buffer = head ?? Buffer.alloc(0);
      let fragments = [];
      let fragmentOpcode = null;
      const consume = () => {
        while (buffer.length >= 2) {
          const byte0 = buffer[0], byte1 = buffer[1];
          const opcode = byte0 & 15, fin = Boolean(byte0 & 0x80);
          const masked = Boolean(byte1 & 0x80);
          let length = byte1 & 127, offset = 2;
          if (!masked) { socket.destroy(); return; }
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(MAX_FRAME)) { socket.destroy(); return; }
            length = Number(big); offset = 10;
          }
          if (length > MAX_FRAME) { socket.destroy(); return; }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
          for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
          buffer = buffer.subarray(offset + 4 + length);
          if (opcode === 8) { socket.end(frame(8)); return; }
          if (opcode === 9) { socket.write(frame(10, payload)); continue; }
          if (opcode === 10) continue;
          if (opcode === 1) { fragments = [payload]; fragmentOpcode = 1; }
          else if (opcode === 0 && fragmentOpcode === 1) fragments.push(payload);
          else { socket.destroy(); return; }
          if (fragments.reduce((n, p) => n + p.length, 0) > MAX_FRAME) { socket.destroy(); return; }
          if (fin) {
            const text = Buffer.concat(fragments).toString('utf8');
            fragments = []; fragmentOpcode = null;
            try { this.#onJson(JSON.parse(text)); } catch { this.emit('invalid', 'invalid_json'); }
          }
        }
      };
      socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); consume(); });
      socket.on('error', (error) => this.emit('error', error));
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null; this.connected = false;
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('OneBot disconnected')); }
        this.pending.clear(); this.emit('close');
      });
      if (buffer.length) consume();
    });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.config.port, this.config.host, resolve); }); }
    catch (error) { server.close(); throw error; }
    this.server = server;
  }

  #onJson(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (data.echo != null) {
      const key = String(data.echo), pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(key);
      if (data.status === 'ok' && Number(data.retcode) === 0) pending.resolve(data);
      else{
        const code=typeof data.message==='string'&&/^[A-Z0-9_]{3,80}$/.test(data.message)?data.message:undefined;
        const error=new Error(`OneBot action failed: ${data.retcode??data.status??'unknown'}${code?' ('+code+')':''}`);
        error.code=code;error.data=data.data;pending.reject(error);
      }
      return;
    }
    try { this.emit('event', data); }
    catch (error) { this.emit('invalid', `event_handler_failed:${error?.message ?? error}`); }
  }

  action(action, params) {
    if (!this.socket || !this.connected) return Promise.reject(new Error('OneBot disconnected'));
    const echo = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`OneBot action timeout: ${action}`)); }, this.config.timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.write(frame(1, JSON.stringify({ action, params, echo })), (error) => {
        if (error && this.pending.delete(echo)) { clearTimeout(timer); reject(error); }
      });
    });
  }

  async stop() {
    this.socket?.end(frame(8)); this.socket?.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
