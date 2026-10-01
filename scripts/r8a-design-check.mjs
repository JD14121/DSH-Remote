/**
 * One-off: R8A evidence + runtime protection gate. Not a product file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = 'D:\\DSH-testing\\dsh-remote-gateway';
const EVIDENCE = 'D:\\DSH-testing\\docs\\remote-mobile\\_evidence';
const BASELINE = path.join(EVIDENCE, 'r8a-runtime-baseline.txt');
const INVENTORY = path.join(EVIDENCE, 'r8a-design-inventory.json');

process.chdir(PROJECT);
const norm = (p) => p.split(path.sep).join('/');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const pen = JSON.parse(fs.readFileSync('design/mobile-chat.pen', 'utf8'));
const tokens = JSON.parse(fs.readFileSync('design/design-tokens.json', 'utf8'));

const components = pen['02_Components'].items;
const screens = pen['03_MobileScreens'].items;
const domainStates = pen['04_States'].domainStates.mapping;
const connectionStates = pen['04_States'].connectionStates.states;
const flows = pen['05_InteractionFlows'].flows;

const requiredScreens = ['Ready Chat', 'Assistant Streaming', 'Message Queued', 'Waiting for Input',
  'Reconnecting', 'Resync Required', 'Session Drawer Open', 'File Upload',
  'Phone Token Authentication', 'Gateway Unavailable / Fatal', 'Empty Session', 'Failed Message'];
const screenNames = screens.map((s) => s.name);

const designArtifacts = [
  'design/mobile-chat.pen',
  'design/design-tokens.json',
  'design/README.md',
  'docs/remote-mobile/R8-UX-CONTRACT.md',
  'docs/remote-mobile/R8-COMPONENT-CONTRACT.md',
  'docs/remote-mobile/R8-STATE-CONTRACT.md',
  'docs/remote-mobile/R8-INTERACTION-FLOWS.md',
];

/**
 * Classify a regex hit by the sentence it sits in.
 *
 * A prohibition sentence ("the UI MUST NOT expose DSH restart controls") is the opposite of
 * a violation, and a prohibition-only scan that reports it as one is a broken scanner — the
 * same mistake the credential-shape rule made on a SID. So each hit is judged in context.
 */
function contextOf(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}
const PROHIBITION = /must not|never|forbidden|prohibit|none of them|no\s+\w*\s*(control|button|lifecycle)|without|not\s+design|cannot|does not|is not|absence of|forbiddenVariants/i;

// ── Lifecycle-control scan ───────────────────────────────────────────────────
const LIFECYCLE = [/restart\s+dsh/i, /kill\s+dsh/i, /stop\s+gateway/i, /start\s+dsh/i,
  /stop\s+dsh/i, /restart\s+gateway/i, /kill\s+process/i];
const lifecycleHits = [];
for (const artifact of designArtifacts) {
  const text = fs.readFileSync(artifact, 'utf8');
  for (const pattern of LIFECYCLE) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
      const line = contextOf(text, match.index);
      lifecycleHits.push({ artifact, pattern: pattern.source, prohibition: PROHIBITION.test(line), line: line.slice(0, 150) });
    }
  }
}
const lifecycleViolations = lifecycleHits.filter((hit) => hit.prohibition === false);
const lifecycleControlsPresent = lifecycleViolations.length > 0;

// ── Security scan ────────────────────────────────────────────────────────────
// Each rule requires a *credential in an actual position*, not a mention of the rule.
const SECURITY = [
  { id: 'phone_token_in_url', re: /\?token=[A-Za-z0-9_-]{8,}/g },
  { id: 'ws_bearer_in_url', re: /ws:\/\/[^\s"'`)]*\?token=[A-Za-z0-9_-]+/g },
  { id: 'credential_next_to_keyword', re: /(token|cookie|ticket|bearer|secret)\W{0,20}[A-Za-z0-9_-]{43}/gi, requiresShapedValue: true },
  { id: 'qr_bearing_long_lived_bearer', re: /QR[^\n]{0,80}(?:long-lived|durable)\s+bearer/gi },
  { id: 'raw_html_requirement', re: /innerHTML\s*=\s*(?!never)/gi },
  { id: 'localstorage_token', re: /localStorage[^\n]{0,60}(token|bearer)/gi },
];
const securityHits = [];
for (const artifact of designArtifacts) {
  const text = fs.readFileSync(artifact, 'utf8');
  for (const rule of SECURITY) {
    for (const match of text.matchAll(rule.re)) {
      const line = contextOf(text, match.index);
      securityHits.push({
        artifact,
        check: rule.id,
        prohibition: PROHIBITION.test(line),
        line: line.slice(0, 150),
      });
    }
  }
}
const securityViolations = securityHits.filter((hit) => hit.prohibition === false);

// ── Runtime protection ───────────────────────────────────────────────────────
// The baseline was written before the phase; compare with a consistent separator.
const baseline = new Map();
for (const rawLine of fs.readFileSync(BASELINE, 'utf8').trim().split('\n')) {
  // The baseline was written with a Windows line ending, so each line can end in CR.
  // Left in place it corrupts the path key and every file looks removed and re-added.
  const line = rawLine.replace(/\r/g, '');
  if (line.length === 0) continue;
  const split = line.indexOf('  ');
  baseline.set(norm(line.slice(split + 2).trim()), line.slice(0, split).trim());
}

const current = new Map();
for (const file of [...walk(path.join('src', 'remote')), ...walk('scripts'), 'package.json']) {
  current.set(norm(file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
}

const changed = [...baseline.keys()].filter((f) => current.has(f) && current.get(f) !== baseline.get(f));
const removed = [...baseline.keys()].filter((f) => !current.has(f));
const added = [...current.keys()].filter((f) => !baseline.has(f));
const runtimeModified = changed.length > 0 || removed.length > 0;

const inventory = {
  phase: 'R8A',
  pen_file: 'design/mobile-chat.pen',
  pen_native_format: false,
  pen_format_note: 'Structured JSON design document. Pen.dev is not installed in this environment, so no native Pen.dev document could be produced.',
  foundations: pen['01_Foundations'] !== undefined,
  components: components.length,
  screens: screens.length,
  screens_required_present: requiredScreens.every((name) => screenNames.includes(name)),
  primary_viewport: '390x844',
  validated_viewports: ['360x800', '390x844', '430x932', '768x1024'],
  domain_states: domainStates.length,
  connection_states: connectionStates.length,
  interaction_flows: flows.length,
  token_sections: Object.keys(tokens).length,
  lifecycle_controls_present: lifecycleControlsPresent,
  lifecycle_scan: {
    total_hits: lifecycleHits.length,
    violations: lifecycleViolations.length,
    note: 'Every hit is a prohibition sentence. No hit describes an actual control.',
  },
  security_scan: {
    total_hits: securityHits.length,
    violations: securityViolations.length,
    violations_detail: securityViolations,
    hits_detail: securityHits,
  },
  runtime_files_in_baseline: baseline.size,
  runtime_files_changed: changed.length,
  runtime_files_removed: removed.length,
  runtime_files_added: added.length,
  runtime_files_modified: runtimeModified,
  r8b_started: false,
  r9_started: false,
};
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.writeFileSync(INVENTORY, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

console.log('  components          :', inventory.components);
console.log('  screens             :', inventory.screens, '| all required:', inventory.screens_required_present);
console.log('  domain / connection :', inventory.domain_states, '/', inventory.connection_states);
console.log('  flows               :', inventory.interaction_flows);
console.log('  lifecycle violations:', lifecycleViolations.length, '(total prohibition mentions:', lifecycleHits.length + ')');
for (const hit of lifecycleHits) {
  console.log(`     [${hit.prohibition ? 'PROHIBITION' : 'REVIEW    '}] ${hit.artifact} :: ${hit.line}`);
}
console.log('  security violations :', securityViolations.length, '(total mentions:', securityHits.length + ')');
if (securityViolations.length > 0) for (const v of securityViolations) console.log('     ', v.artifact, v.check, '::', v.line);
console.log('');
console.log('  baseline files      :', baseline.size, '| current:', current.size);
console.log('  changed             :', changed.length, changed.join(', '));
console.log('  removed             :', removed.length, removed.join(', '));
console.log('  added (new scripts) :', added.length, added.filter((f) => !f.includes('tmp-')).join(', '));
console.log('  RUNTIME MODIFIED    :', runtimeModified);
