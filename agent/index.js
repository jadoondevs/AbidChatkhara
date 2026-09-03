#!/usr/bin/env node
// Entry point: read the printer config from the environment, start the
// HTTP agent on the till, and keep it running.

import { loadConfig } from './src/config.js';
import { Printer } from './src/printer.js';
import { createAgentServer } from './src/server.js';

const config = loadConfig();
const printer = new Printer(config);
const server = createAgentServer(printer, {
  density: config.density,
  // eslint-disable-next-line no-console
  log: (message) => console.log(`[print-agent] ${message}`),
});

server.listen(config.listenPort, '127.0.0.1', () => {
  const target = config.type === 'device' ? config.device : `${config.host}:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(`[print-agent] listening on http://127.0.0.1:${config.listenPort} -> ${config.type} printer at ${target}`);
});
