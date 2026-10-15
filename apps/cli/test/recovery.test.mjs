import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { attachTerminal } from '../src/terminal.mjs';
import { reconnectDelay } from '../../desktop/electron/proxy-bridge.mjs';

test('daemon and CLI bridge retry backoff is bounded without an attempt limit', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 1000, Number.MAX_SAFE_INTEGER].map(reconnectDelay),
    [500, 1000, 2000, 4000, 5000, 5000, 5000],
  );
});

test('--single remains attached while transport recovery replaces the native process', async () => {
  let terminal;
  const requests = [];
  const connection = {
    request: async (message) => {
      requests.push(message);
    },
    control() {},
    onTerminal(listener) {
      terminal = listener;
      return () => {};
    },
    closed: new Promise(() => {}),
  };
  const input = new EventEmitter();
  input.resume = input.pause = input.setRawMode = () => {};
  const output = new EventEmitter();
  let text = '';
  output.write = (data, done) => {
    text += data;
    done?.();
  };
  const handle = attachTerminal(connection, 'same-session', { input, output, detachable: false });
  let exited = false;
  handle.exited.then(() => {
    exited = true;
  });
  terminal({ type: 'terminal.opened', sessionId: 'same-session', terminalId: 'logical-terminal' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(exited, false);
  // The bridge preserves the logical ID even though the remote process changed.
  terminal({ type: 'terminal.opened', sessionId: 'same-session', terminalId: 'logical-terminal' });
  terminal({
    type: 'terminal.data',
    sessionId: 'same-session',
    terminalId: 'logical-terminal',
    data: 'conversation continued',
    bytes: 22,
  });
  assert.match(text, /conversation continued/);
  assert.equal(requests.length, 1, 'no new conversation is requested by the pane');
  terminal({
    type: 'terminal.closed',
    sessionId: 'same-session',
    terminalId: 'logical-terminal',
    exitCode: 7,
  });
  assert.equal((await handle.exited).code, 7);
});
