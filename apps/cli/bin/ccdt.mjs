#!/usr/bin/env node
import { main } from '../src/main.mjs';

const code = await main(process.argv.slice(2));
// Writes to a pipe finish asynchronously; exiting first would cut output at the pipe's 64 KiB buffer. A reader that
// has gone away (`| head`) ends the wait with an error instead.
await Promise.all(
  [process.stdout, process.stderr].map(
    (stream) =>
      new Promise((resolve) => {
        stream.once('error', resolve);
        stream.write('', resolve);
      }),
  ),
);
// stdin may still hold the event loop after the terminal is restored, so the code is handed over explicitly.
process.exit(code);
