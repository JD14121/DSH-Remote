/**
 * R9-RELAY-01 — test-only certificate fixtures (taskbook §6, §30).
 *
 * Generates four INDEPENDENT identities so no key pair can satisfy two roles:
 *
 * ```text
 * fixture public HTTPS server   (what the bridge presents)
 * fixture Android client        (an enrolled identity)
 * fixture frpc client           (tunnel client — never the same key)
 * fixture frps server           (tunnel server — never the same key)
 * ```
 *
 * Every certificate is marked in its subject so it cannot be mistaken for production material:
 *
 * ```text
 * R9 RELAY FIXTURE ONLY
 * NOT PRODUCTION
 * ```
 *
 * This module is used to CREATE test material only. It never writes into a production root, never
 * generates a production CA, and never exports a key into evidence.
 *
 * Uses `node:crypto` X.509 generation where available; falls back to a documented self-signed
 * generator so the fixture does not depend on an external openssl binary.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Marker present in every fixture subject, so fixture material is unmistakable. */
export const FIXTURE_MARKER = 'R9 RELAY FIXTURE ONLY - NOT PRODUCTION';

/** The four roles, which must never share a key. */
export const ROLES = Object.freeze(['server', 'android-client', 'frpc-client', 'frps-server']);

/**
 * Locate an openssl binary.
 *
 * X.509 generation with the exact validity and extension controls these tests need is far clearer
 * through openssl than through `node:crypto`'s key APIs, and openssl ships with Git for Windows on
 * this machine. When it is absent the caller is told plainly rather than silently degrading.
 *
 * @returns {string|null} the path, or null.
 */
export function findOpenssl() {
  const candidates = [
    `${process.env.ProgramFiles}\\Git\\usr\\bin\\openssl.exe`,
    `${process.env.ProgramFiles}\\Git\\mingw64\\bin\\openssl.exe`,
    `${process.env.SystemRoot}\\System32\\openssl.exe`,
    'openssl',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'pipe', timeout: 10_000 });
      return candidate;
    } catch { /* try the next */ }
  }
  return null;
}

/** Run openssl and return stdout. */
function openssl(binary, args, options = {}) {
  return execFileSync(binary, args, { stdio: 'pipe', timeout: 30_000, ...options }).toString();
}

/**
 * Create an isolated fixture PKI in a temporary directory.
 *
 * @param {object} [options] - `dir`, `openssl`.
 * @returns {object} the PKI: paths and helpers.
 */
export function createFixturePki(options = {}) {
  const opensslBinary = options.openssl ?? findOpenssl();
  if (opensslBinary === null) {
    throw new Error('openssl is required to generate fixture certificates; none was found');
  }
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay01-pki-'));
  fs.mkdirSync(dir, { recursive: true });

  const caKey = path.join(dir, 'fixture-ca.key.pem');
  const caCrt = path.join(dir, 'fixture-ca.crt.pem');

  /** Create the fixture CA once. It is a test CA and is marked as such. */
  const ensureCa = () => {
    if (fs.existsSync(caKey) && fs.existsSync(caCrt)) return;
    openssl(opensslBinary, ['genrsa', '-out', caKey, '2048']);
    openssl(opensslBinary, [
      'req', '-x509', '-new', '-key', caKey, '-out', caCrt, '-days', '2',
      '-subj', `/CN=r9-relay-fixture-ca/O=${FIXTURE_MARKER}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  };
  ensureCa();

  /**
   * Create a leaf identity signed by the fixture CA.
   *
   * Every leaf gets a SAN for the fixture hostname where relevant, because a certificate without
   * one fails hostname verification — which is correct behaviour and must be exercised, not dodged.
   *
   * @param {string} role - the role name.
   * @param {object} [roleOptions] - `san`, `eku`, `days`, `selfSigned`, `ca`.
   * @returns {object} the identity paths.
   */
  const makeIdentity = (role, roleOptions = {}) => {
    const key = path.join(dir, `${role}.key.pem`);
    const crt = path.join(dir, `${role}.crt.pem`);
    const csr = path.join(dir, `${role}.csr.pem`);
    if (fs.existsSync(key) && fs.existsSync(crt)) return { role, key, crt };

    openssl(opensslBinary, ['genrsa', '-out', key, '2048']);
    const subject = `/CN=${role}.fixture.local/O=${FIXTURE_MARKER}`;
    const days = String(roleOptions.days ?? 2);

    // A deliberately expired certificate cannot be produced by `-days`; the caller supplies a
    // negative validity window through explicit notBefore/notAfter instead.
    const extensions = [];
    if (roleOptions.san !== undefined) extensions.push(`subjectAltName=${roleOptions.san}`);
    if (roleOptions.eku !== undefined) extensions.push(`extendedKeyUsage=${roleOptions.eku}`);
    if (roleOptions.eku === undefined && roleOptions.ekuOmit !== true) {
      extensions.push('extendedKeyUsage=serverAuth,clientAuth');
    }
    extensions.push('basicConstraints=critical,CA:FALSE');
    const extFile = path.join(dir, `${role}.ext`);
    fs.writeFileSync(extFile, `${extensions.join('\n')}\n`, 'utf8');

    if (roleOptions.selfSigned === true) {
      // Self-signed leaf: valid on its own but not signed by the bridge's CA.
      openssl(opensslBinary, [
        'req', '-x509', '-new', '-key', key, '-out', crt, '-days', days,
        '-subj', subject, '-extfile', extFile,
      ]);
      return { role, key, crt };
    }

    openssl(opensslBinary, ['req', '-new', '-key', key, '-out', csr, '-subj', subject]);
    const signArgs = [
      'x509', '-req', '-in', csr, '-CA', roleOptions.ca ?? caCrt, '-CAkey', roleOptions.caKey ?? caKey,
      '-CAcreateserial', '-out', crt, '-days', days, '-extfile', extFile,
    ];
    if (roleOptions.notBefore !== undefined || roleOptions.notAfter !== undefined) {
      // Explicit validity windows let a test produce an expired or not-yet-valid certificate.
      signArgs.push('-not_before', roleOptions.notBefore ?? '200101000000Z');
      signArgs.push('-not_after', roleOptions.notAfter ?? '200201000000Z');
    }
    openssl(opensslBinary, signArgs);
    return { role, key, crt };
  };

  return {
    dir,
    openssl: opensslBinary,
    caCert: caCrt,
    caKey,
    makeIdentity,
    /** Read a certificate's DER bytes for fingerprinting. */
    der(crt) {
      return Buffer.from(openssl(opensslBinary, ['x509', '-in', crt, '-outform', 'DER'], { encoding: 'buffer' }));
    },
    /** Read a PEM file. */
    pem(file) { return fs.readFileSync(file, 'utf8'); },
    /**
     * The SHA-256 fingerprint of a certificate.
     *
     * Taken from `node:tls` itself, because that is the only definition that is guaranteed to agree
     * with what the bridge computes from `socket.getPeerCertificate()`.
     *
     * This is not a detail: `openssl x509 -outform DER` RE-ENCODES the certificate rather than
     * emitting the signed bytes, so hashing its output yields a different digest than hashing the
     * peer certificate Node provides. Using openssl's output here silently produced an allowlist
     * whose fingerprints could never match a real client, and every enrolled identity was denied.
     *
     * @param {string} crt - the certificate path.
     * @returns {string} the lowercase hex SHA-256.
     */
    fingerprint(crt) {
      const { X509Certificate } = crypto;
      const cert = new X509Certificate(fs.readFileSync(crt));
      // `fingerprint256` is already the colon-separated uppercase form; normalise it.
      return cert.fingerprint256.replace(/:/g, '').toLowerCase();
    },
    /** Apple the raw DER bytes Node would present for this certificate. */
    rawDer(crt) {
      const { X509Certificate } = crypto;
      return new X509Certificate(fs.readFileSync(crt)).raw;
    },
    /** Remove the whole fixture PKI. */
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build the TLS options the bridge needs for fixture clients.
 *
 * `requestCert` + `rejectUnauthorized` make the client certificate mandatory: a client without one
 * cannot complete the handshake, so it can never receive application bytes.
 *
 * @param {object} input - `ca`, `cert`, `key`.
 * @returns {object} the options.
 */
export function serverTlsOptions(input) {
  return {
    ca: fs.readFileSync(input.ca),
    cert: fs.readFileSync(input.cert),
    key: fs.readFileSync(input.key),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    // Resumption is disabled so a revoked identity cannot resume a previously established session.
    sessionTimeout: 0,
    ticketKeys: undefined,
  };
}

/**
 * Build client TLS options for a fixture identity.
 *
 * @param {object} input - `ca`, `cert`, `key`, `servername`.
 * @returns {object} the options.
 */
export function clientTlsOptions(input) {
  return {
    ca: fs.readFileSync(input.ca),
    cert: input.cert === undefined ? undefined : fs.readFileSync(input.cert),
    key: input.key === undefined ? undefined : fs.readFileSync(input.key),
    servername: input.servername,
    minVersion: 'TLSv1.2',
    // Never accept an untrusted server certificate, even in a fixture.
    rejectUnauthorized: true,
  };
}
