/**
 * R8A.1 — pen.dev canvas driver.
 *
 * Talks to the pen.dev desktop app through its MCP server over stdio, so the native
 * document is authored on a real canvas rather than hand-written JSON. This is the tool
 * that makes "Pen.dev was actually used" true rather than asserted.
 *
 * Usage:
 *   node scripts/pen-canvas.mjs state
 *   node scripts/pen-canvas.mjs exec <snippet-file>
 *   node scripts/pen-canvas.mjs eval "<inline js>"
 *
 * Not a runtime artifact: nothing in src/remote imports it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EXE = 'C:\\Program Files\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';
const APP = 'desktop';
const AGENT = 'claudeDesktop';

/**
 * The document this driver edits.
 *
 * `filePath` is declared required by the `execute` tool schema even though its description
 * says "optional", so it is always sent.
 */
const DOC = process.env.PEN_DOC
  ?? 'D:\\DSH-testing\\dsh-remote-gateway\\design\\mobile-chat.pen';

/**
 * Open an MCP session against the running pen.dev app.
 *
 * @returns {Promise<{call: Function, close: Function}>} the session.
 */
async function connect() {
  const child = spawn(EXE, ['--app', APP, '--agent', AGENT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* a non-JSON line is not a response */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 120000);
    });
  };

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-r8a1', version: '1.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const call = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
    return (res.result?.content ?? []).map((entry) => entry.text ?? '').join('\n');
  };

  return {
    call,
    stderr: () => stderr,
    close: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

const [command, ...rest] = process.argv.slice(2);
const session = await connect();

try {
  if (command === 'state') {
    process.stdout.write(await session.call('get_app_state', {}));
  } else if (command === 'eval' || command === 'exec') {
    const snippet = command === 'exec'
      ? fs.readFileSync(rest[0], 'utf8')
      : rest.join(' ');
    const result = await session.call('execute', { filePath: DOC, input: snippet });
    process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  } else if (command === 'skill') {
    process.stdout.write(await session.call('read_skill', rest[0] === undefined ? {} : { path: rest[0] }));
  } else {
    process.stderr.write('usage: state | eval "<js>" | exec <file> | skill [path]\n');
    process.exitCode = 2;
  }
} finally {
  session.close();
}
