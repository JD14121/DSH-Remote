/**
 * R8G.2 — build the DSH Remote USB debug APK.
 *
 * Builds with the Android SDK build-tools directly rather than Gradle. The harness is one activity
 * with no dependencies, so the toolchain is the whole build: `aapt2` compiles and links resources,
 * `javac` compiles the activity, `d8` produces dex, and `apksigner` signs. That keeps the build
 * offline, deterministic and reproducible from tools the SDK already provides — no Gradle
 * distribution download, no plugin resolution, no dependency cache to keep in sync.
 *
 * ## Why the packaged APK is rewritten
 *
 * `classes.dex` has to sit at the APK root, and appending the entry to aapt2's output does not
 * work: that output is not a plain local-then-central ZIP — it carries extra data after the
 * central directory — so computing the new offset from the central directory's end lands inside
 * that trailing data and produces an archive `zipalign` refuses. Letting `aapt2 compile` include
 * the dex instead fails silently, because aapt2 only compiles recognised resource types and skips
 * anything else without a warning.
 *
 * The APK is therefore read as a ZIP and written back out as a clean, standard one with the dex
 * added (see `scripts/lib/zip.mjs`). One `aapt2 link` pass is then enough.
 *
 * Usage: node scripts/r8g2-build-apk.mjs [--sdk D:\\Android] [--out <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { addEntries } from './lib/zip.mjs';
import { resolveAndroidBuildVariant } from './r8g2-android-variants.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const variant = resolveAndroidBuildVariant(flag('--variant', 'development'));
const SDK = flag('--sdk', process.env.ANDROID_HOME ?? 'D:\\Android');
const JAVA_HOME = flag('--java-home', process.env.JAVA_HOME ?? path.join(SDK, 'jdk-home'));
const PROJECT = flag('--project', path.join(process.cwd(), 'android'));
const defaultApkName = variant.name === 'development' ? 'dsh-remote-debug.apk' : 'dsh-remote-relay.apk';
const OUT = flag('--out', path.join(PROJECT, 'out', defaultApkName));

const BUILD_TOOLS = path.join(SDK, 'build-tools', '34.0.0');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-34', 'android.jar');

const AAPT2 = path.join(BUILD_TOOLS, 'aapt2.exe');
const D8 = path.join(BUILD_TOOLS, 'd8.bat');
const APKSIGNER = path.join(BUILD_TOOLS, 'apksigner.bat');
const ZIPALIGN = path.join(BUILD_TOOLS, 'zipalign.exe');
const JAVAC = path.join(JAVA_HOME, 'bin', 'javac.exe');
const KEYTOOL = path.join(JAVA_HOME, 'bin', 'keytool.exe');

const APP = path.join(PROJECT, 'app');
const SRC = path.join(APP, 'src', 'main');
const VARIANT_SRC = path.join(APP, 'src', variant.name === 'development' ? 'development' : 'relay');
const WORK = path.join(PROJECT, 'out', 'work');

const MIN_SDK = '26';
const TARGET_SDK = '34';

/** The tools that are batch files. `spawnSync` cannot execute a `.bat` directly (EINVAL), so they
 *  are routed through `cmd.exe /c`. */
const BATCH = new Set([D8, APKSIGNER, ZIPALIGN].map((p) => p.toLowerCase()));

/** Run a tool, failing loudly with the tool's own output. */
function run(label, command, commandArgs, options = {}) {
  process.stdout.write(`  ${label}\n`);
  const viaCmd = BATCH.has(command.toLowerCase());
  const finalCommand = viaCmd ? 'cmd.exe' : command;
  const finalArgs = viaCmd ? ['/c', command, ...commandArgs] : commandArgs;
  try {
    const output = execFileSync(finalCommand, finalArgs, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (output && output.trim().length > 0) {
      for (const line of output.trim().split('\n').slice(-4)) process.stdout.write(`      ${line.trim()}\n`);
    }
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    process.stderr.write(`\n  FAILED: ${label}\n`);
    // `status` is null when the process could not be spawned at all, so report the code too —
    // otherwise a spawn failure looks like a silent non-result.
    process.stderr.write(`  exit=${error.status} code=${error.code ?? 'n/a'}${error.message ? ` (${error.message.split('\n')[0]})` : ''}\n`);
    if (stdout.trim()) process.stderr.write(`${stdout.trim().split('\n').slice(-30).join('\n')}\n`);
    if (stderr.trim()) process.stderr.write(`${stderr.trim().split('\n').slice(-30).join('\n')}\n`);
    throw new Error(`${label} failed with exit ${error.status}`);
  }
}

/** Recursively collect files by extension. */
function collect(dir, extension, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

// ── preflight ────────────────────────────────────────────────────────────────
for (const [label, file] of [
  ['aapt2', AAPT2], ['d8', D8], ['apksigner', APKSIGNER], ['zipalign', ZIPALIGN],
  ['javac', JAVAC], ['keytool', KEYTOOL], ['android.jar', ANDROID_JAR],
  ['AndroidManifest.xml', path.join(variant.name === 'development' ? SRC : VARIANT_SRC, 'AndroidManifest.xml')],
]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`);
}
process.stdout.write(`  sdk   : ${SDK}\n  java  : ${JAVA_HOME}\n  out   : ${OUT}\n\n`);

fs.rmSync(WORK, { recursive: true, force: true });
for (const dir of ['compiled', 'classes', 'dex', 'r']) {
  fs.mkdirSync(path.join(WORK, dir), { recursive: true });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const MANIFEST = path.join(SRC, 'AndroidManifest.xml');
const selectedManifest = variant.name === 'development' ? MANIFEST : path.join(VARIANT_SRC, 'AndroidManifest.xml');
const stagedRes = path.join(WORK, 'res');
fs.cpSync(path.join(SRC, 'res'), stagedRes, { recursive: true });
if (variant.name !== 'development') fs.cpSync(path.join(VARIANT_SRC, 'res'), stagedRes, { recursive: true, force: true });
const compiledResources = path.join(WORK, 'compiled', 'res.zip');
const R_JAVA = path.join(WORK, 'r');

/** The `aapt2 link` arguments that are identical in both passes. */
const linkArgs = (outputApk) => [
  'link',
  '-o', outputApk,
  '-I', ANDROID_JAR,
  '--manifest', selectedManifest,
  '--custom-package', 'dev.dsh.remotedebug',
  '--min-sdk-version', MIN_SDK,
  '--target-sdk-version', TARGET_SDK,
  '--version-code', '1',
  '--version-name', `1.0-${variant.name}`,
  '--no-version-vectors',
];

// ── 1. compile resources ─────────────────────────────────────────────────────
run('aapt2 compile (resources)', AAPT2, ['compile', '--dir', stagedRes, '-o', compiledResources]);

// ── 2. first link: emit R.java ───────────────────────────────────────────────
const baseApk = path.join(WORK, 'base.apk');
run('aapt2 link (pass 1: R.java)', AAPT2, [
  ...linkArgs(baseApk),
  '--java', R_JAVA,
  compiledResources,
]);

// ── 3. compile the Java ──────────────────────────────────────────────────────
const generatedDir = path.join(WORK, 'generated', 'dev', 'dsh', 'remotedebug');
fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(path.join(generatedDir, 'BuildConfig.java'), `package dev.dsh.remotedebug;\npublic final class BuildConfig {\n public static final boolean REMOTE_RELAY = ${variant.remoteRelay};\n public static final boolean WEBVIEW_DEBUGGING_ENABLED = ${variant.webViewDebuggingEnabled};\n private BuildConfig() {}\n}\n`, 'utf8');
const javaSources = [...collect(path.join(SRC, 'java'), '.java'), ...collect(R_JAVA, '.java'), path.join(generatedDir, 'BuildConfig.java')];
if (javaSources.length === 0) throw new Error('no Java sources found');

run(`javac (${javaSources.length} source file(s))`, JAVAC, [
  // `-encoding UTF-8` is mandatory, not cosmetic: on a zh-CN Windows host javac defaults to GBK,
  // and the sources contain non-ASCII punctuation in comments. Without this the compiler fails on
  // its own comments.
  '-encoding', 'UTF-8',
  '-source', '17', '-target', '17',
  // No `-bootclasspath`: modern javac removed it. `android.jar` on the classpath supplies the
  // platform classes.
  '-nowarn',
  '-classpath', ANDROID_JAR,
  '-Xlint:none',
  '-d', path.join(WORK, 'classes'),
  ...javaSources,
]);

// ── 4. dex ───────────────────────────────────────────────────────────────────
const classFiles = collect(path.join(WORK, 'classes'), '.class');

// Passed through an argument file rather than on the command line. `d8.bat` runs through cmd.exe,
// whose command line tops out around 8 KB; the absolute paths of the class files exceed that and
// the spawn fails outright. Entries are written bare: R8 does NOT strip surrounding quotes from an
// argfile line, so a quoted path becomes a path whose first character is a literal `"`.
const d8Args = path.join(WORK, 'd8-args.txt');
fs.writeFileSync(d8Args, classFiles.map((file) => (file.includes(' ') ? `"${file}"` : file)).join('\n'), 'utf8');
const dexDir = path.join(WORK, 'dex');
run(`d8 (${classFiles.length} class file(s), via argfile)`, D8, [
  '--min-api', MIN_SDK,
  '--lib', ANDROID_JAR,
  '--output', dexDir,
  `@${d8Args}`,
]);

const dexFile = path.join(dexDir, 'classes.dex');
if (!fs.existsSync(dexFile)) throw new Error('d8 produced no classes.dex');

// ── 5. package classes.dex into the APK ──────────────────────────────────────
//
// The APK is read as a ZIP and rewritten with the dex added as a STORED entry, at the root, which
// is what the runtime requires. See the header comment and `scripts/lib/zip.mjs` for why the entry
// cannot simply be appended to aapt2's output.
const unsigned = path.join(WORK, 'unsigned.apk');
const names = addEntries(baseApk, unsigned, [{ name: 'classes.dex', data: fs.readFileSync(dexFile) }]);
process.stdout.write(`  package classes.dex into the APK\n`);
process.stdout.write(`      entries: ${names.length} (${names.join(', ')})\n`);
if (!names.includes('classes.dex')) throw new Error('classes.dex did not land in the APK');

// ── 6. keystore ──────────────────────────────────────────────────────────────
// A debug key, generated once and reused. It is not a secret and must never sign a release; the
// password is deliberately non-default so it cannot be confused with a stock Android debug key.
//
// It lives at `android/debug.keystore`, NOT under `android/out`. `out` is wiped at the start of
// every build, so keeping the key there silently regenerated it each time — every build produced a
// differently-signed APK and `adb install -r` failed with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
const keystore = flag('--keystore', path.join(PROJECT, 'debug.keystore'));
if (!fs.existsSync(keystore)) {
  run('keytool (generate debug keystore)', KEYTOOL, [
    '-genkeypair',
    '-keystore', keystore,
    '-storetype', 'PKCS12',
    '-alias', 'dsh-remote-debug',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', 'dsh-remote-debug',
    '-keypass', 'dsh-remote-debug',
    '-dname', 'CN=DSH Remote Debug, OU=R8G2, O=DSH, L=local, ST=local, C=ZZ',
  ]);
} else {
  process.stdout.write(`  keytool (reusing ${path.relative(PROJECT, keystore)})\n`);
}

// ── 7. align then sign ───────────────────────────────────────────────────────
// Alignment happens BEFORE signing: apksigner records the alignment, so zipalign afterwards would
// invalidate the signature.
const aligned = path.join(WORK, 'aligned.apk');
run('zipalign', ZIPALIGN, ['-f', '-p', '4', unsigned, aligned]);

run('apksigner (sign: v1 + v2 + v3)', APKSIGNER, [
  'sign',
  '--ks', keystore,
  '--ks-type', 'PKCS12',
  '--ks-key-alias', 'dsh-remote-debug',
  '--ks-pass', 'pass:dsh-remote-debug',
  '--key-pass', 'pass:dsh-remote-debug',
  '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true',
  '--v3-signing-enabled', 'true',
  '--out', OUT,
  aligned,
]);

run('apksigner verify', APKSIGNER, ['verify', '--verbose', '--print-certs', OUT]);

// ── 8. report ────────────────────────────────────────────────────────────────
const stat = fs.statSync(OUT);
const sha = createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');

process.stdout.write(`\n  built  : ${OUT}`);
process.stdout.write(`\n  bytes  : ${stat.size}`);
process.stdout.write(`\n  sha256 : ${sha}\n`);
