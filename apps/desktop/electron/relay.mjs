import { connect } from 'node:net';
import { WebSocket, createWebSocketStream } from 'ws';
import { RELAY_BEGIN } from '@cc-desk-tunnel/protocol';

const SPARE = 2;
const MAX_FAILURES = 5;

// The desktop side of the service's relay: keeps a few signed-in WSS connections waiting, and when the service
// hands one an SSH connection, splices it to the local SSH endpoint and opens a replacement. `openSocket` returns an
// open connection whose certificate has already been checked, so the secret goes nowhere else.
export function startRelay({ connectionId, secret }, port, openSocket, onFailure) {
  const sockets = new Set();
  let closed = false;
  let failures = 0;
  let retryTimer;
  const fail = (message) => {
    if (closed) return;
    close();
    onFailure(message);
  };
  // Connections that never got as far as a hand-over count as failures; enough of them in a row end the tunnel.
  const retry = () => {
    if (closed || retryTimer) return;
    if (++failures >= MAX_FAILURES) return fail('执行通道中继连接反复失败，请检查网络后重新连接。');
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void open();
      },
      250 * 2 ** failures,
    );
  };
  async function open() {
    let socket;
    try {
      socket = await openSocket();
    } catch {
      return retry();
    }
    if (closed) return socket.terminate();
    sockets.add(socket);
    let begun = false;
    socket.on('error', () => socket.terminate());
    socket.once('close', (code) => {
      sockets.delete(socket);
      if (begun || closed) return;
      if (code === 4001) fail('执行通道中继认证失败。');
      else if (code !== 4008) retry();
    });
    socket.once('message', (data, isBinary) => {
      if (isBinary || data.toString('utf8') !== RELAY_BEGIN) return socket.terminate();
      begun = true;
      failures = 0;
      void open();
      // The stream takes over the socket's messages from here, in the same tick, so no bytes are missed.
      const stream = createWebSocketStream(socket);
      const local = connect(port, '127.0.0.1');
      stream.on('error', () => local.destroy());
      local.on('error', () => stream.destroy());
      local.once('close', () => stream.destroy());
      stream.pipe(local);
      local.pipe(stream);
    });
    socket.send(JSON.stringify({ type: 'tunnel.attach', connectionId, secret }));
  }
  function close() {
    closed = true;
    clearTimeout(retryTimer);
    for (const socket of sockets) socket.terminate();
    sockets.clear();
  }
  for (let index = 0; index < SPARE; index++) void open();
  return { close };
}

// Waits for a relay WebSocket to open; rejects if it closes or fails first.
export function opened(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Relay connection closed')));
  });
}
