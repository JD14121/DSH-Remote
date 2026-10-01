/**
 * R9-RELAY-04 — isolated production mobile runtime factory.
 *
 * The executable configuration is fail-closed and production binds only 127.0.0.1:9446.
 * Tests may supply an ephemeral loopback upstream and listener port explicitly with `testMode`;
 * the CLI never enables that option. This module does not start or manage the R7 Gateway.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBridge } from './bridge.mjs';
import { IdentityPolicy } from './identity-policy.mjs';

export const R9_RELAY_04_HOST = 'relay.drm-jd.com';
export const R9_RELAY_04_ORIGIN = `https://${R9_RELAY_04_HOST}`;
export const R9_RELAY_04_LISTEN = Object.freeze({ host: '127.0.0.1', port: 9446 });
export const R9_RELAY_04_UPSTREAM = Object.freeze({ host: '127.0.0.1', port: 9445 });

/** Verify the exact UI file set and content hashes before it can be served. */
export function verifyR9UiArtifact(uiRoot, manifestPath) {
  const root = fs.realpathSync(uiRoot);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('R9-04 UI manifest is invalid');
  const expected = new Map();
  for (const entry of manifest.files) {
    if (typeof entry?.path !== 'string' || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error('R9-04 UI manifest contains an unsafe path');
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || expected.has(entry.path)) throw new Error('R9-04 UI manifest entry is invalid');
    const candidate = path.resolve(root, entry.path);
    const actualPath = fs.realpathSync(candidate);
    if (!(actualPath === root || actualPath.startsWith(`${root}${path.sep}`)) || !fs.statSync(actualPath).isFile()) throw new Error('R9-04 UI manifest path escapes the artifact or is not a file');
    const data = fs.readFileSync(actualPath);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== entry.sha256 || data.length !== entry.bytes) throw new Error(`R9-04 UI artifact integrity mismatch: ${entry.path}`);
    expected.set(entry.path, entry);
  }
  const actual = [];
  const walk = (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error('R9-04 UI artifact must not contain symlinks');
      if (item.isDirectory()) walk(path.join(directory, item.name), relative);
      else if (item.isFile()) actual.push(relative);
      else throw new Error('R9-04 UI artifact contains a special file');
    }
  };
  walk(root);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) throw new Error('R9-04 UI artifact files do not match the manifest');
  if (!expected.has('index.html')) throw new Error('R9-04 UI manifest must include index.html');
  return Object.freeze([...expected.keys()]);
}

/** Validate production configuration and verify the referenced public materials exist. */
export function validateR9ProductionConfig(config, { testMode = false } = {}) {
  if (config === null || typeof config !== 'object') throw new TypeError('R9-04 configuration must be an object');
  if (config.listenHost !== R9_RELAY_04_LISTEN.host) throw new Error('R9-04 listener must bind 127.0.0.1 only');
  if (!testMode && config.listenPort !== R9_RELAY_04_LISTEN.port) throw new Error('R9-04 production listener port must be 9446');
  if (config.publicHostname !== R9_RELAY_04_HOST) throw new Error('R9-04 public hostname must be relay.drm-jd.com');
  if (!Array.isArray(config.gatewayAllowedOrigins) || config.gatewayAllowedOrigins.length !== 1 || config.gatewayAllowedOrigins[0] !== R9_RELAY_04_ORIGIN) {
    throw new Error('R9-04 Gateway Origin allowlist must contain only https://relay.drm-jd.com');
  }
  if (config.gatewayUpstreamHost !== '127.0.0.1') throw new Error('R9-04 Gateway upstream must be fixed to 127.0.0.1');
  if (!Number.isInteger(config.gatewayUpstreamPort) || config.gatewayUpstreamPort < 1 || config.gatewayUpstreamPort > 65535) throw new Error('R9-04 Gateway upstream port is invalid');
  if (!testMode && config.gatewayUpstreamPort !== R9_RELAY_04_UPSTREAM.port) throw new Error('R9-04 production Gateway upstream port must be 9445');
  if (testMode && [9445, 9446].includes(config.gatewayUpstreamPort)) throw new Error('R9-04 synthetic tests must not target accepted or production ports');

  const requiredFiles = [
    ['HTTPS server certificate', config.httpsCertPath],
    ['HTTPS server private key', config.httpsKeyPath],
    ['Android application client CA certificate', config.androidClientCaPath],
  ];
  for (const [label, file] of requiredFiles) {
    if (typeof file !== 'string' || file.length === 0 || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${label} is missing or not a regular file`);
    }
  }
  if (typeof config.uiRoot !== 'string' || !path.isAbsolute(config.uiRoot) || !fs.existsSync(config.uiRoot) || !fs.statSync(config.uiRoot).isDirectory()) {
    throw new Error('R9-04 production UI root is missing or not a directory');
  }
  if (typeof config.uiManifestPath !== 'string' || !path.isAbsolute(config.uiManifestPath) || !fs.existsSync(config.uiManifestPath) || !fs.statSync(config.uiManifestPath).isFile()) throw new Error('R9-04 production UI manifest is missing');
  const uiFiles = verifyR9UiArtifact(config.uiRoot, config.uiManifestPath);
  if (!Array.isArray(config.enrolledIdentityFingerprints) || config.enrolledIdentityFingerprints.length === 0) {
    throw new Error('R9-04 enrolled Android identity allowlist must not be empty');
  }
  const fingerprints = config.enrolledIdentityFingerprints.map((value) => String(value).toLowerCase());
  if (fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value)) || new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('R9-04 identity allowlist must contain unique SHA-256 fingerprints');
  }

  return Object.freeze({ ...config, enrolledIdentityFingerprints: Object.freeze(fingerprints), uiRoot: path.resolve(config.uiRoot), uiFiles });
}

/** Create (but do not listen with) the dedicated R9-04 bridge. */
export function createR9ProductionBridge(config, { testMode = false, onEvent } = {}) {
  const valid = validateR9ProductionConfig(config, { testMode });
  const policy = valid.enrolledIdentityFingerprints.reduce(
    (current, fingerprint, index) => current.withAllowed({ fingerprint, label: `android-enrolled-${index + 1}` }),
    IdentityPolicy.empty(),
  );
  const bridge = createBridge({
    tlsOptions: {
      cert: fs.readFileSync(valid.httpsCertPath),
      key: fs.readFileSync(valid.httpsKeyPath),
      ca: fs.readFileSync(valid.androidClientCaPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    upstream: { host: valid.gatewayUpstreamHost, port: valid.gatewayUpstreamPort },
    policy,
    hostname: valid.publicHostname,
    origin: R9_RELAY_04_ORIGIN,
    staticRoot: valid.uiRoot,
    staticFiles: valid.uiFiles,
    preserveValidatedOrigin: true,
    requireSni: true,
    onEvent,
  });
  if (!testMode) {
    const fixedListen = bridge.listen.bind(bridge);
    bridge.listen = (port = R9_RELAY_04_LISTEN.port) => {
      if (port !== R9_RELAY_04_LISTEN.port) throw new Error('R9-04 production listener port is fixed to 9446');
      return fixedListen(port);
    };
  }
  return bridge;
}

/** Read the JSON config named by R9_RELAY_04_CONFIG; no defaults may silently weaken production. */
export function loadR9ProductionConfig(file = process.env.R9_RELAY_04_CONFIG) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('R9_RELAY_04_CONFIG must name the production JSON configuration');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateR9ProductionConfig(parsed);
}
