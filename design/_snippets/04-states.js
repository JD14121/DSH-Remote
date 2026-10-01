ids = {};
Get((n) => { if (n.reusable === true && n.id) ids[n.name] = n.id; });

const F = (name, over) => Object.assign({
  type: 'frame', name, layout: 'vertical', gap: 8,
  fill: '$surface.primary', cornerRadius: '$r3', stroke: '$border.default', strokeWidth: 1,
  clip: false
}, over);
const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 13,
  fill: '$text.primary', textGrowth: 'fit_content'
}, over);
const chip = (parent, name, label, color) => {
  const c = Insert(parent, {
    type: 'frame', name, layout: 'horizontal', alignItems: 'center', gap: 6,
    fill: '$surface.secondary', cornerRadius: '$rPill', padding: [6, 12], width: 'fit_content'
  });
  Insert(c, { type: 'ellipse', name: name + ' Dot', width: 8, height: 8, fill: color });
  Insert(c, T(name + ' Label', label, { fontSize: 12, fontWeight: '600' }));
  return c;
};

states = Insert(document, {
  type: 'frame', name: '04 States', layout: 'horizontal', gap: 24, padding: 40,
  fill: '$bg.primary', cornerRadius: 24, width: 'fit_content', height: 'fit_content', clip: false
});
Insert(states, T('States Title', 'States', { fontSize: 32, fontWeight: '700' }));

domainCol = Insert(states, F('Domain States', { width: 320, gap: 12, padding: 20 }));
Insert(domainCol, T('Domain Heading', 'Domain state — 8, fixed (R2)', { fontSize: 17, fontWeight: '600' }));
Insert(domainCol, T('Domain Note', 'Server-derived. No ninth status may be added.', { fontSize: 11, fill: '$text.muted' }));
for (const s of ['idle', 'queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled', 'disconnected']) {
  chip(domainCol, 'Domain ' + s, s, s === 'failed' ? '$status.danger' : (s === 'running' ? '$accent.primary' : '$text.secondary'));
}
Insert(domainCol, T('Domain Count', 'count = 8', { fontSize: 11, fill: '$text.muted' }));

connCol = Insert(states, F('Connection States', { width: 320, gap: 12, padding: 20 }));
Insert(connCol, T('Connection Heading', 'Connection state — 6 (UI only)', { fontSize: 17, fontWeight: '600' }));
Insert(connCol, T('Connection Note', 'Client-derived. Independent axis, never merged.', { fontSize: 11, fill: '$text.muted' }));
for (const s of ['auth_required', 'connecting', 'connected', 'reconnecting', 'resync_required', 'gateway_unavailable']) {
  chip(connCol, 'Connection ' + s, s, s === 'gateway_unavailable' ? '$status.danger' : (s === 'connected' ? '$status.success' : '$status.warning'));
}
Insert(connCol, T('Connection Count', 'count = 6', { fontSize: 11, fill: '$text.muted' }));

matrix = Insert(states, F('Axis Independence', { width: 360, gap: 10, padding: 20 }));
Insert(matrix, T('Matrix Heading', 'The two axes are independent', { fontSize: 17, fontWeight: '600' }));
Insert(matrix, T('Matrix Note', 'Domain x Connection. Both axes hold at once.', { fontSize: 11, fill: '$text.muted' }));
legalRows = [
  ['running', 'reconnecting', 'LEGAL — the turn was running when the link dropped'],
  ['queued', 'reconnecting', 'LEGAL — the queue survives the outage'],
  ['waiting_input', 'reconnecting', 'LEGAL — reply drafted, unsendable'],
  ['idle', 'connected', 'LEGAL — the ordinary case']
];
for (const [d, c2, why] of legalRows) {
  r = Insert(matrix, {
    type: 'frame', name: 'Combo ' + d + '+' + c2, layout: 'vertical', gap: 2,
    fill: '$surface.secondary', cornerRadius: '$r2', padding: 10, width: 'fill_container'
  });
  Insert(r, T('Combo Label ' + d, d + '  +  ' + c2, { fontSize: 13, fontWeight: '600', fill: '$status.success' }));
  Insert(r, T('Combo Why ' + d, why, { fontSize: 11, fill: '$text.muted' }));
}
Insert(matrix, T('Matrix Rule', 'Forbidden: collapsing the two axes into one enum.', { fontSize: 11, fill: '$status.warning' }));

badge = Insert(states, F('ConnectionBadge Variants', { width: 300, gap: 10, padding: 20 }));
Insert(badge, T('Badge Heading', 'ConnectionBadge — 6 variants', { fontSize: 17, fontWeight: '600' }));
Insert(badge, T('Badge Note', 'Each carries icon + text, never colour alone.', { fontSize: 11, fill: '$text.muted' }));
Insert(badge, { type: 'ref', name: 'Badge Ready', ref: ids.ConnectionBadge });
if (ids.Toast) Insert(badge, { type: 'ref', name: 'Badge Toast Ref', ref: ids.Toast });
