/** Fixed Android launch variants for the loopback development shell and production relay shell. */
export const ANDROID_BUILD_VARIANTS = Object.freeze({
  development: Object.freeze({
    name: 'development', applicationId: 'dev.dsh.remotedebug',
    launchUrl: 'http://localhost:8099/', remoteRelay: false,
    usesCleartextTraffic: true, cleartextPolicy: 'localhost-only', webViewDebuggingEnabled: true,
  }),
  relay: Object.freeze({
    name: 'relay', applicationId: 'dev.dsh.remotedebug.relay',
    launchUrl: 'https://relay.drm-jd.com/', remoteRelay: true,
    usesCleartextTraffic: false, cleartextPolicy: 'deny-all', webViewDebuggingEnabled: false,
  }),
});

export function resolveAndroidBuildVariant(name = 'development') {
  const variant = ANDROID_BUILD_VARIANTS[name];
  if (!variant) throw new Error(`unknown Android build variant: ${name}`);
  return variant;
}
