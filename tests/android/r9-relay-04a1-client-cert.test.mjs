import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const activityPath = path.join(root, 'android/app/src/main/java/dev/dsh/remotedebug/MainActivity.java');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const activity = fs.readFileSync(activityPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`unterminated method ${signature}`);
}

function requireSource(pattern, message) {
  assert.ok(pattern.test(activity), message);
}

test('localhost development start URL remains unchanged', () => {
  assert.match(activity, /START_URL\s*=\s*"http:\/\/localhost:8099\/"/);
  assert.doesNotMatch(activity, /START_URL\s*=\s*"https:\/\/relay\.drm-jd\.com/);
});

test('only relay.drm-jd.com:443 passes the production client certificate gate', () => {
  const body = methodBody(activity, 'private static boolean isProductionClientCertificateRequest(');
  requireSource(/CLIENT_CERT_HOST\s*=\s*"relay\.drm-jd\.com"/, 'production hostname must be exact');
  requireSource(/CLIENT_CERT_PORT\s*=\s*443/, 'production port must be exact');
  assert.match(body, /host\s*!=\s*null\s*&&\s*CLIENT_CERT_HOST\.equalsIgnoreCase\(host\)\s*&&\s*port\s*==\s*CLIENT_CERT_PORT/);
  requireSource(/onReceivedClientCertRequest\s*\(/, 'WebView client-cert callback must be implemented');
});

test('wrong hostname cannot pass the client identity scope gate', () => {
  const body = methodBody(activity, 'private static boolean isProductionClientCertificateRequest(');
  assert.match(body, /CLIENT_CERT_HOST\.equalsIgnoreCase\(host\)/);
  requireSource(/CLIENT_CERT_HOST\s*=\s*"relay\.drm-jd\.com"/, 'scope must be pinned to the relay hostname');
});

test('wrong port cannot pass the client identity scope gate', () => {
  const body = methodBody(activity, 'private static boolean isProductionClientCertificateRequest(');
  assert.match(body, /port\s*==\s*CLIENT_CERT_PORT/);
  requireSource(/CLIENT_CERT_PORT\s*=\s*443/, 'scope must be pinned to HTTPS port 443');
});

test('out-of-scope requests cancel before any KeyChain lookup or selection', () => {
  const body = methodBody(activity, 'public void onReceivedClientCertRequest(WebView view, ClientCertRequest request)');
  const guard = body.indexOf('isProductionClientCertificateRequest');
  const cancel = body.indexOf('request.cancel()');
  const keychain = body.indexOf('KeyChain.');
  assert.ok(guard >= 0 && cancel > guard, 'out-of-scope requests must cancel at the scope guard');
  assert.ok(keychain < 0 || keychain > cancel, 'KeyChain must not be consulted before scope rejection');
});

test('missing alias opens the explicit Android KeyChain chooser and chooser cancellation fails closed', () => {
  requireSource(/KeyChain\.choosePrivateKeyAlias\s*\(/, 'missing alias must invoke Android KeyChain selection UI');
  requireSource(/putString\s*\(\s*CLIENT_CERT_ALIAS_KEY\s*,\s*selectedAlias\s*\)/, 'only the selected alias is persisted');
  requireSource(/selectedAlias\s*==\s*null[\s\S]{0,260}waitingRequest\.cancel\s*\(\s*\)/, 'chooser cancellation must cancel the request');
});

test('selected alias resolves KeyChain private key and certificate chain before proceeding', () => {
  requireSource(/KeyChain\.getPrivateKey\s*\(/, 'private key must come from Android KeyChain');
  requireSource(/KeyChain\.getCertificateChain\s*\(/, 'certificate chain must come from Android KeyChain');
  requireSource(/privateKey\s*==\s*null\s*\|\|\s*chain\s*==\s*null\s*\|\|\s*chain\.length\s*==\s*0/, 'missing key or chain must invalidate the identity');
  requireSource(/request\.proceed\s*\(\s*resolvedKey\s*,\s*resolvedChain\s*\)/, 'only resolved key and chain may be supplied');
  requireSource(/request\.cancel\s*\(\s*\)/, 'incomplete identity must cancel');
});

test('missing private key cancels instead of proceeding', () => {
  const validation = methodBody(activity, 'private static boolean hasUsableClientIdentity(');
  const resolver = methodBody(activity, 'private void resolveClientIdentity(');
  assert.match(validation, /privateKey\s*==\s*null/);
  assert.match(resolver, /!hasUsableClientIdentity\(resolvedKey,\s*resolvedChain\)[\s\S]*?request\.cancel\(\)[\s\S]*?return;/);
});

test('missing or empty certificate chain cancels instead of proceeding', () => {
  const validation = methodBody(activity, 'private static boolean hasUsableClientIdentity(');
  const resolver = methodBody(activity, 'private void resolveClientIdentity(');
  assert.match(validation, /chain\s*==\s*null\s*\|\|\s*chain\.length\s*==\s*0/);
  assert.match(resolver, /!hasUsableClientIdentity\(resolvedKey,\s*resolvedChain\)[\s\S]*?request\.cancel\(\)[\s\S]*?return;/);
});

test('WebView client-certificate rejection never calls ignore', () => {
  assert.doesNotMatch(activity, /request\.ignore\s*\(/);
});

test('server TLS validation has no permissive SSL error path', () => {
  assert.doesNotMatch(activity, /onReceivedSslError|SslErrorHandler/);
  assert.doesNotMatch(activity, /handler\.proceed\s*\(/);
});

test('app source contains no client private key or P12/PFX identity material', () => {
  const sourceRoot = path.join(root, 'android/app/src');
  const forbiddenExtensions = /\.(?:p12|pfx)$/i;
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }
  const files = walk(sourceRoot);
  assert.deepEqual(files.filter((file) => forbiddenExtensions.test(file)), []);
  for (const file of files.filter((item) => /\.(?:java|xml|properties|json|html|js|kt)$/i.test(item))) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, file);
    assert.doesNotMatch(content, /-----BEGIN (?:PKCS12|PFX)-----/i, file);
  }
});

test('INTERNET remains the only declared app permission', () => {
  const permissions = [...manifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(permissions, ['android.permission.INTERNET']);
});
