import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { ConfigError, isLoopback, loadConfig } from './config.ts';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const app = createApp(cfg);
const server = serve({ fetch: app.fetch, hostname: cfg.http.host, port: cfg.http.port }, (info) => {
  const where = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  console.log(
    `ObjectLens listening on http://${where}:${info.port} with ${cfg.connections.length} connection(s): ` +
      (cfg.connections.map((c) => `${c.name}${c.readOnly ? ' (read-only)' : ''}`).join(', ') || 'none'),
  );
}) as Server;
// Uploads and downloads stream through the server and may take hours: no request timeout
// (Node's default of 5 minutes would cut large transfers).
server.requestTimeout = 0;

if (!cfg.connections.length) console.warn('No S3 connection is configured; set S3_1_ENDPOINT etc. (see .env.example).');
if (!isLoopback(cfg.http.host)) {
  console.warn(
    `LISTEN_HOST=${cfg.http.host}: ObjectLens has no login; anyone who can reach this address can use its S3 ` +
      'credentials. In a container, publish the port on 127.0.0.1 only (-p 127.0.0.1:3000:3000).',
  );
}

// Graceful shutdown on SIGTERM (docker stop) and SIGINT (Ctrl+C). Node runs as PID 1 in the
// container, where signals without a handler are ignored.
const SHUTDOWN_TIMEOUT_MS = 8000; // below Docker's default 10 s grace period
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    console.warn(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => {
    console.error(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000} s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    console.log('shutdown complete');
    process.exit(0);
  });
  // Idle keep-alive connections would hold close() open.
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
