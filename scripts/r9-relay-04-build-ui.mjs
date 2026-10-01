import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ONLY = Object.freeze({
  'api/dev-proxy.mjs': 'Node-only development HTTP/WebSocket server; no HTML, module, or stylesheet in the browser entrypoint closure imports it.',
});

/** Resolve browser references and reject traversal outside the approved UI tree. */
function resolveReference(root, from, reference) {
  const raw = reference.trim();
  if (!raw || raw.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(raw)) return null;
  const value = raw.replace(/[?#].*$/, '');
  if (!value) return null;
  const target = value.startsWith('/') ? value.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) throw new Error(`reference escapes the approved UI root: ${from} -> ${reference}`);
  const absolute = path.resolve(root, ...target.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`reference escapes the approved UI root: ${from} -> ${reference}`);
  return target;
}

/** Enumerate and follow browser dependencies from HTML, JS modules, CSS, and CSS assets. */
export function auditR9UiDependencyClosure({ sourceRoot }) {
  if (typeof sourceRoot !== 'string') throw new TypeError('sourceRoot is required');
  const root = fs.realpathSync(sourceRoot);
  const inventory = [];
  const walk = (dir, rel = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`R9-04 UI source contains a symlink: ${next}`);
      if (item.isDirectory()) walk(path.join(dir, item.name), next);
      else if (item.isFile()) inventory.push(next);
      else throw new Error(`R9-04 UI source contains a special file: ${next}`);
    }
  };
  walk(root);
  const reachable = new Set();
  const queue = ['index.html'];
  const enqueue = (from, ref) => { const target = resolveReference(root, from, ref); if (target) queue.push(target); };
  while (queue.length) {
    const rel = queue.shift();
    if (reachable.has(rel)) continue;
    const absolute = path.resolve(root, ...rel.split('/'));
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`reference escapes the approved UI root: ${rel}`);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`missing browser dependency: ${rel}`);
    reachable.add(rel);
    const body = fs.readFileSync(absolute, 'utf8');
    if (/\.(?:m?js)$/i.test(rel)) {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const pattern = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*\)/g;
      for (const match of code.matchAll(pattern)) enqueue(rel, match[2] ?? match[4]);
      if (/\bimport\s*\(\s*(?!['"])/.test(code)) throw new Error(`non-literal dynamic import cannot be audited: ${rel}`);
    } else if (/\.html?$/i.test(rel)) {
      for (const match of body.matchAll(/<(script|link|img|source|video|audio|iframe|object)\b([^>]*)>/gi)) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];
        const attr = tag === 'link' ? (/(?:^|\s)rel\s*=\s*(['"])(?:stylesheet|license)\1/i.test(attrs) ? 'href' : null)
          : tag === 'object' ? 'data' : 'src';
        if (!attr) continue;
        const ref = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(['"])(.*?)\\1`, 'i').exec(attrs)?.[2];
        if (ref && (tag === 'script' || tag === 'link' || /\.(?:svg|png|jpe?g|webp|woff2?|ttf|ico)(?:[?#]|$)/i.test(ref))) enqueue(rel, ref);
      }
    } else if (/\.css$/i.test(rel)) {
      for (const match of body.matchAll(/@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/gi)) enqueue(rel, match[2]);
      for (const match of body.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) enqueue(rel, match[2]);
    }
  }
  const excludedFiles = inventory.filter((file) => !reachable.has(file)).map((file) => {
    if (!DEV_ONLY[file]) throw new Error(`unreferenced UI source has no approved exclusion: ${file}`);
    return { path: file, reason: DEV_ONLY[file] };
  });
  return Object.freeze({ sourceFiles: inventory.sort(), reachableFiles: [...reachable].sort(), excludedFiles });
}

/** Build a deterministic, development-proxy-free static UI artifact and manifest. */
export function buildR9UiArtifact({ sourceRoot, outputRoot }) {
  if (typeof sourceRoot !== 'string' || typeof outputRoot !== 'string') throw new TypeError('sourceRoot and outputRoot are required');
  const source = fs.realpathSync(sourceRoot);
  const output = path.resolve(outputRoot);
  if (fs.existsSync(output)) throw new Error(`R9-04 UI artifact output already exists: ${output}`);
  if (output === source || output.startsWith(`${source}${path.sep}`)) throw new Error('R9-04 UI artifact output cannot be inside the source tree');
  const uiRoot = path.join(output, 'ui');
  fs.mkdirSync(uiRoot, { recursive: true });
  const closure = auditR9UiDependencyClosure({ sourceRoot: source });
  const files = [];
  for (const rel of closure.reachableFiles) {
    const input = path.resolve(source, ...rel.split('/'));
    const destination = path.resolve(uiRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const data = fs.readFileSync(input);
    fs.writeFileSync(destination, data, { flag: 'wx' });
    files.push({ path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  const manifest = { version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  const manifestPath = path.join(output, 'ui-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const closurePath = path.join(output, 'dependency-closure-evidence.json');
  fs.writeFileSync(closurePath, `${JSON.stringify({ version: 1, sourceRoot: source, ...closure, packagedFiles: manifest.files.map(({ path: file }) => file) }, null, 2)}\n`, { flag: 'wx' });
  return Object.freeze({ outputRoot: output, uiRoot, manifestPath, closurePath, files: manifest.files, closure });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceRoot = path.join(projectRoot, 'src', 'remote', 'ui');
  const outputRoot = path.resolve(process.env.R9_RELAY_04_UI_OUT ?? path.join(projectRoot, 'artifacts', 'r9-relay-04'));
  const result = buildR9UiArtifact({ sourceRoot, outputRoot });
  process.stdout.write(`R9-04 UI artifact: ${result.uiRoot}\nManifest: ${result.manifestPath}\nDependency closure: ${result.closurePath}\nFiles: ${result.files.length}\n`);
}
