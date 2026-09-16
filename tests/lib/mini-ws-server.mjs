// Minimal WebSocket server — vanilla Node (node:http + node:crypto only, no
// `ws` package, nothing new in tools/package.json). Exists solely so
// tests/gpu/bench-livestream-realtime.mjs can drive webSMLM.html's real
// liveStreamWsConnect() wire protocol end-to-end without shelling out to
// tools/test_livestream_demo.py's Python server (the user explicitly asked
// for a vanilla-JS live-stream test). Plays the same "server the browser
// connects out to" role that script and the Micro-Manager plugin play,
// scripted instead of driven by hand.
//
// Deliberately narrow: only what a real Chromium WebSocket client (the only
// kind of client this ever talks to) actually sends — single, unfragmented
// text/binary/close/ping frames, always masked (client->server frames are
// masked per RFC 6455 §5.3; this ALWAYS unmasks incoming frames and NEVER
// masks outgoing ones, matching the spec's asymmetric requirement exactly).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // RFC 6455's fixed handshake constant

// onConnection(conn) fires once per WebSocket upgrade. conn:
//   onMessage((payload:Buffer, isBinary:boolean) => void)
//   sendText(str) / sendBinary(buf)
//   close()
// Resolves to {port, close()} once listening on an ephemeral localhost port.
export function startMiniWsServer({ onConnection }) {
  const httpServer = createServer((req, res) => { res.writeHead(404); res.end(); });
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnection(wrapSocket(socket));
  });
  httpServer.on('clientError', () => {});   // a plain (non-upgrade) HTTP request on this port — ignore, don't crash the server
  return new Promise(resolve => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({ port, close: () => httpServer.close() });
    });
  });
}

function wrapSocket(socket) {
  const listeners = { message: [], close: [] };
  let buf = Buffer.alloc(0);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = tryParseFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);
      if (frame.opcode === 0x8) { socket.end(); return; }                           // close
      if (frame.opcode === 0x9) { sendFrame(socket, 0xA, frame.payload); continue; }  // ping -> pong
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        for (const cb of listeners.message) cb(frame.payload, frame.opcode === 0x2);
      }
    }
  });
  socket.on('close', () => { for (const cb of listeners.close) cb(); });
  socket.on('error', () => {});   // a dropped connection mid-test surfaces as a timeout in the caller, not a crash here

  return {
    onMessage(cb) { listeners.message.push(cb); },
    onClose(cb) { listeners.close.push(cb); },
    sendText(str) { sendFrame(socket, 0x1, Buffer.from(str, 'utf8')); },
    sendBinary(payload) { sendFrame(socket, 0x2, payload); },
    close() { try { sendFrame(socket, 0x8, Buffer.alloc(0)); } catch { /* already closed */ } socket.end(); },
  };
}

// Server->client frames are sent UNMASKED (spec requires the opposite
// direction to be masked) — single-frame (FIN=1), no fragmentation, all this
// harness ever needs.
function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;   // FIN=1
  socket.write(Buffer.concat([header, payload]));
}

// Parses ONE client->server frame (always masked per spec) from the front of
// buf; null if a complete frame hasn't fully arrived yet.
function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let maskKey = null;
  if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.subarray(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }
  return { opcode, payload, consumed: offset + len };
}
