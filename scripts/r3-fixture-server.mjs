/**
 * R3 fixture server — Phase R3 §33.
 *
 * Serves the REST contract over **synthetic data only**, so a human can browse
 * the API without a running DSH and without any credential.
 *
 * Guarantees required by §33:
 *   - binds `127.0.0.1` only (the config layer makes any other host throw);
 *   - uses synthetic fixture data exclusively;
 *   - prints a SYNTHETIC/FIXTURE banner;
 *   - the real DSH is never contacted;
 *   - it must not be mistaken for the production server.
 *
 * Usage:
 *   node scripts/r3-fixture-server.mjs [--port 9445]
 */

import { createRemoteHttpServer } from '../src/remote/server.mjs';
import { EventsService } from '../src/remote/events.mjs';
import { MessagesService } from '../src/remote/messages.mjs';
import { SessionsService } from '../src/remote/sessions.mjs';
import { StatusService } from '../src/remote/status-service.mjs';
import { resolveHttpConfig } from '../src/remote/http/config.mjs';
import { createFixtureAdapter, disableNetwork, seedFixtureStore } from './fixture-adapter.mjs';

// Make "this fixture server never contacts DSH" a runtime guarantee, not a claim.
disableNetwork();

/** Fixed clock so fixture timestamps are reproducible. */
const clock = () => 1_789_800_000_000;

/**
 * Read `--port` from argv.
 *
 * @returns {number|undefined} the requested port.
 */
function argPort() {
  const index = process.argv.indexOf('--port');
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

// Deliberately ASCII: a Windows console often decodes UTF-8 output as a legacy
// code page, which would render an em dash as mojibake even though the source is
// perfectly valid UTF-8. Operator-facing console text stays ASCII to avoid that.
const banner = `
================================================================
  DSH REMOTE GATEWAY - SYNTHETIC FIXTURE SERVER
================================================================
  This server serves FIXTURE DATA ONLY.

    * It does NOT connect to DSH.
    * It does NOT read any credential, cookie or token.
    * It is NOT the production gateway and must not be treated
      as one.
    * Bound to 127.0.0.1 only, so it is reachable from this
      machine alone.

  Contract reference: docs/r3-rest-contract.md
================================================================
`;

const adapter = createFixtureAdapter({ clock });
const store = seedFixtureStore(adapter, clock);
const sessionsService = new SessionsService({ adapter, store, clock });
const messagesService = new MessagesService({ adapter, store, clock });
const eventsService = new EventsService({ adapter, store, clock });
const statusService = new StatusService({ adapter, eventsService, clock });

const config = resolveHttpConfig(
  { ...(argPort() === undefined ? {} : { port: argPort() }), dshVersion: '0.1.5-rc.2 (fixture)' },
  {},
);

const server = createRemoteHttpServer({
  sessionsService,
  messagesService,
  eventsService,
  statusService,
  adapter,
  config,
  healthFacts: () => ({
    gateway: 'ready',
    ready: true,
    dsh: { status: 'ready', version: '0.1.5-rc.2 (fixture)' },
  }),
  // Explicit: a synthetic fixture must never create a durable state root, and after
  // R5A the factory requires the decision rather than defaulting to one.
  persistence: null,
  // R6 §5: explicit, and visibly unauthenticated because this is synthetic data.
  auth: null,
});

await server.start();
const address = server.address();

console.log(banner);
console.log(`listening on http://${address.host}:${address.port}/api/v1`);
console.log('try:');
console.log(`  curl http://${address.host}:${address.port}/api/v1/health`);
console.log(`  curl http://${address.host}:${address.port}/api/v1/sessions`);
console.log('');
console.log('Press Ctrl+C to stop.');

/** Stop cleanly on a signal, without ever touching a DSH process. */
const shutdown = async () => {
  console.log('\nstopping fixture server...');
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
