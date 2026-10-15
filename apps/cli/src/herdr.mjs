import { execFile } from 'node:child_process';

// Inside a Herdr pane, tells Herdr what the agent on screen is doing, so the pane shows its state and notifies the
// way it does for a Claude Code running in the pane itself. Herdr cannot tell by itself: the CLI runs on the service
// and this pane holds only ccdt. The state is the service's own, from its Claude Code hooks; `starting` is unknown.
const HERDR_STATE = { busy: 'working', waiting: 'blocked', idle: 'idle' };

// A pane of Herdr's own: Herdr's variables without a tmux or zellij between it and ccdt, which would be the pane
// ccdt shows in (the innermost multiplexer wins), not the Herdr pane those variables name.
export function herdrPane(env = process.env) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || env.TMUX || env.ZELLIJ) return null;
  return env.HERDR_PANE_ID;
}

const runHerdr = (args) =>
  new Promise((resolve) => {
    try {
      execFile('herdr', args, { timeout: 3000 }, () => resolve());
    } catch {
      resolve();
    }
  });

// Reports run one at a time, in order, and only on a change. Failures are ignored: Herdr is only a display here.
export function herdrReporter(pane, run = runHerdr) {
  let sessionId = null;
  let reported = null;
  // Herdr orders a source's reports by this number; a later ccdt in the same pane starts above an earlier one.
  let seq = Date.now();
  let queue = Promise.resolve();
  const send = (args) => {
    queue = queue.then(() => run(args)).catch(() => {});
  };
  return {
    // The agent now on screen, and the latest `terminals.state` list.
    attach(id, terminals = []) {
      sessionId = id;
      reported = null;
      this.update(terminals);
    },
    update(terminals) {
      if (!sessionId) return;
      const status = terminals.find((terminal) => terminal.sessionId === sessionId)?.status;
      const state = HERDR_STATE[status] ?? 'unknown';
      if (state === reported) return;
      reported = state;
      send([
        'pane',
        'report-agent',
        pane,
        '--source',
        'ccdt',
        '--agent',
        'claude',
        '--state',
        state,
        '--seq',
        String(++seq),
      ]);
    },
    // The agent left the screen: Herdr goes back to its own detection.
    detach() {
      if (!sessionId) return;
      sessionId = null;
      reported = null;
      send([
        'pane',
        'release-agent',
        pane,
        '--source',
        'ccdt',
        '--agent',
        'claude',
        '--seq',
        String(++seq),
      ]);
    },
    settled: () => queue,
  };
}
