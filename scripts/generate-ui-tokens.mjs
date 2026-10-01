/**
 * Generate src/remote/ui/styles/tokens.css from design/design-tokens.json.
 *
 * The token file is the authority; the CSS is derived. Generating it rather than hand-copying
 * it means the UI cannot silently drift from the frozen design contract — re-run this after
 * any token change.
 *
 * Usage: node scripts/generate-ui-tokens.mjs [--check]
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TOKENS = path.join(ROOT, 'design', 'design-tokens.json');
const OUT = path.join(ROOT, 'src', 'remote', 'ui', 'styles', 'tokens.css');

const tokens = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));

const lines = [];
const push = (s) => lines.push(s);

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

push('/*');
push(' * Design tokens as CSS custom properties.');
push(' *');
push(' * GENERATED from design/design-tokens.json by scripts/generate-ui-tokens.mjs.');
push(' * Do not edit by hand: re-run the generator instead, so the UI cannot drift from the');
push(' * frozen design contract.');
push(' */');
push('');
push(':root {');

push('  /* colour */');
for (const [group, value] of Object.entries(tokens.color)) {
  if (group === 'comment') continue;
  if (typeof value === 'string') {
    push(`  --${group}: ${value};`);
    continue;
  }
  for (const [name, colour] of Object.entries(value)) {
    // A nested `comment` is prose, not a colour. Emitting it produced a variable whose value was
    // a sentence, which is how a documentation string ended up in the stylesheet.
    if (name === 'comment') continue;
    push(`  --${group}-${kebab(name)}: ${colour};`);
  }
}

push('');
push('  /* spacing */');
for (const [name, value] of Object.entries(tokens.spacing)) {
  if (name === 'comment') continue;
  push(`  --space-${kebab(name)}: ${value}px;`);
}

push('');
push('  /* radius */');
for (const [name, value] of Object.entries(tokens.radius)) {
  if (name === 'comment') continue;
  push(`  --radius-${kebab(name)}: ${value}px;`);
}

push('');
push('  /* typography */');
for (const [name, value] of Object.entries(tokens.typography.families)) {
  push(`  --font-${kebab(name)}: ${value};`);
}
for (const [role, spec] of Object.entries(tokens.typography.scale)) {
  push(`  --text-${kebab(role)}-size: ${spec.size}px;`);
  push(`  --text-${kebab(role)}-line: ${spec.lineHeight}px;`);
  push(`  --text-${kebab(role)}-weight: ${spec.weight};`);
}

push('');
push('  /* elevation (R8G) */');
for (const [name, value] of Object.entries(tokens.elevation ?? {})) {
  if (name === 'comment') continue;
  push(`  --elevation-${kebab(name)}: ${value};`);
}

push('');
push('  /* touch targets */');
for (const [name, value] of Object.entries(tokens.touchTarget)) {
  if (name === 'comment') continue;
  push(`  --touch-${kebab(name)}: ${value}px;`);
}

push('');
push('  /* message geometry */');
push(`  --message-max-width: ${tokens.message.maxWidthPercent}%;`);
push(`  --message-gap: ${tokens.message.groupGapPx}px;`);
push(`  --message-padding: ${tokens.message.bubblePaddingPx}px;`);

push('');
push('  /* layout */');
for (const [name, value] of Object.entries(tokens.layout)) {
  if (name === 'comment') continue;
  if (typeof value !== 'number') continue;
  push(`  --layout-${kebab(name)}: ${value}px;`);
}

push('');
push('  /* motion */');
for (const name of ['fast', 'base', 'slow']) {
  push(`  --motion-${name}: ${tokens.motion[name]}ms;`);
}

push('');
push('  /* accessibility */');
for (const [name, value] of Object.entries(tokens.accessibility)) {
  if (name === 'comment' || typeof value !== 'number') continue;
  push(`  --a11y-${kebab(name)}: ${value};`);
}

push('');
push('  /* z-index layers — no component may invent a higher value */');
for (const [name, value] of Object.entries(tokens.zIndex)) {
  if (name === 'comment') continue;
  push(`  --z-${kebab(name)}: ${value};`);
}

push('');
push(`  /* breakpoints (informational — media queries cannot read custom properties) */`);
for (const [name, value] of Object.entries(tokens.breakpoints)) {
  if (name === 'comment') continue;
  push(`  --bp-${kebab(name)}: ${value}px;`);
}

push('}');
push('');

const css = lines.join('\n');

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== css) {
    console.error('tokens.css is out of date — re-run node scripts/generate-ui-tokens.mjs');
    process.exit(1);
  }
  console.log('tokens.css is up to date');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, css, 'utf8');
console.log(`wrote ${path.relative(ROOT, OUT)} (${css.split('\n').length - 1} lines)`);
