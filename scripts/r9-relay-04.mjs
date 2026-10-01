import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createR9ProductionBridge, loadR9ProductionConfig } from '../src/remote/r9/production-runtime.mjs';

export async function startR9Relay04() {
  const config = loadR9ProductionConfig();
  const bridge = createR9ProductionBridge(config);
  const port = await bridge.listen(config.listenPort);
  process.stdout.write(`R9-04 loopback bridge listening on 127.0.0.1:${port} for ${config.publicHostname}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
  };
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
  return { bridge, config, port, stop };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await startR9Relay04(); }
  catch (error) {
    process.stderr.write(`R9-04 startup refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
