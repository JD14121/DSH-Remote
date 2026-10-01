import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ANDROID_BUILD_VARIANTS, resolveAndroidBuildVariant } from '../../scripts/r8g2-android-variants.mjs';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('development APK remains a launcher-ready localhost shell with its existing debug posture', () => {
  const dev = resolveAndroidBuildVariant('development');
  assert.equal(dev.launchUrl, 'http://localhost:8099/');
  assert.equal(dev.applicationId, 'dev.dsh.remotedebug');
  assert.equal(dev.usesCleartextTraffic, true);
  assert.equal(dev.cleartextPolicy, 'localhost-only');
  assert.equal(dev.webViewDebuggingEnabled, true);
});

test('relay APK is a distinct launcher app with a fixed HTTPS URL and hardened WebView posture', () => {
  const relay = resolveAndroidBuildVariant('relay');
  assert.equal(relay.launchUrl, 'https://relay.drm-jd.com/');
  assert.equal(relay.applicationId, 'dev.dsh.remotedebug.relay');
  assert.equal(relay.usesCleartextTraffic, false);
  assert.equal(relay.cleartextPolicy, 'deny-all');
  assert.equal(relay.webViewDebuggingEnabled, false);
  assert.notEqual(relay.applicationId, resolveAndroidBuildVariant('development').applicationId);
});

test('variant resolution accepts only the two fixed launch targets', () => {
  assert.deepEqual(Object.keys(ANDROID_BUILD_VARIANTS).sort(), ['development', 'relay']);
  assert.throws(() => resolveAndroidBuildVariant('https://attacker.example/'), /unknown Android build variant/);
});

test('relay launcher manifest denies all cleartext and requests only INTERNET', () => {
  const manifest = read('../../android/app/src/relay/AndroidManifest.xml');
  const network = read('../../android/app/src/relay/res/xml/network_security_config.xml');
  assert.match(manifest, /package="dev\.dsh\.remotedebug\.relay"/);
  assert.match(manifest, /usesCleartextTraffic="false"/);
  assert.deepEqual([...manifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map((m) => m[1]), ['android.permission.INTERNET']);
  assert.match(network, /base-config\s+cleartextTrafficPermitted="false"/);
  assert.doesNotMatch(network, /domain-config|cleartextTrafficPermitted="true"/);
});

test('activity launch URL and WebView debugging are selected at build time only', () => {
  const source = read('../../android/app/src/main/java/dev/dsh/remotedebug/MainActivity.java');
  assert.match(source, /BuildConfig\.REMOTE_RELAY\s*\?\s*PRODUCTION_RELAY_URL\s*:\s*START_URL/);
  assert.match(source, /setWebContentsDebuggingEnabled\(BuildConfig\.WEBVIEW_DEBUGGING_ENABLED\)/);
  assert.doesNotMatch(source, /EXTRA_USE_PRODUCTION_RELAY|getBooleanExtra\(/);
});
