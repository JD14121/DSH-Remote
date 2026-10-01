import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../android/app/src/main/java/dev/dsh/remotedebug/MainActivity.java', import.meta.url), 'utf8');

test('Android development keeps localhost and relay launch is a fixed build variant', () => {
  assert.match(source, /START_URL\s*=\s*"http:\/\/localhost:8099\/"/);
  assert.match(source, /PRODUCTION_RELAY_URL\s*=\s*"https:\/\/relay\.drm-jd\.com\/"/);
  assert.match(source, /return\s+BuildConfig\.REMOTE_RELAY\s*\?\s*PRODUCTION_RELAY_URL\s*:\s*START_URL/);
  assert.doesNotMatch(source, /EXTRA_USE_PRODUCTION_RELAY|getBooleanExtra\(/);
  assert.match(source, /setWebContentsDebuggingEnabled\(BuildConfig\.WEBVIEW_DEBUGGING_ENABLED\)/);
  assert.match(source, /CLIENT_CERT_HOST\s*=\s*"relay\.drm-jd\.com"/);
  assert.match(source, /CLIENT_CERT_PORT\s*=\s*443/);
});
