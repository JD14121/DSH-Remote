ids = {};
Get((n) => { if (n.reusable === true && n.id) ids[n.name] = n.id; });

Get((n) => { if (n.name === 'T01 Tablet Ready Chat') Delete(n.id); });

board = '';
Get((n) => { if (n.name === '03 Mobile Screens') board = n.id; });

const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 12,
  fill: '$text.primary', textGrowth: 'fit_content'
}, over);

const W = 768;
const H = 1024;
const RAIL = 300;
const CHAT = W - RAIL;
const BAR = 56;
const TLH = 700;
const FOOT = H - BAR - TLH;

col = Insert(board, {
  type: 'frame', name: 'T01 Tablet Ready Chat', layout: 'vertical', gap: 16,
  width: 'fit_content', height: 'fit_content', fill: '#0B0D11'
});
Insert(col, T('T01 Label', 'T01 Tablet Ready Chat — 768x1024', { fontSize: 14, fontWeight: '600', fill: '#7E8698' }));

body = Insert(col, {
  type: 'frame', name: 'T01 Tablet Ready Chat Body', layout: 'horizontal', gap: 0,
  width: W, height: H, fill: '$bg.primary', cornerRadius: 16, clip: true,
  stroke: '#2A3140', strokeWidth: 1
});

rail = Insert(body, {
  type: 'frame', name: 'T01 Rail', layout: 'vertical', gap: 12,
  width: RAIL, height: H, fill: '$bg.secondary', padding: 16, clip: true
});
Insert(rail, { type: 'ref', name: 'T01 Rail Drawer', ref: ids.SessionDrawer, width: RAIL - 32 });
Insert(rail, T('T01 Rail Head Note', 'Persistent rail — same components as mobile, layout only.',
  { fontSize: 10, fill: '$text.muted', width: RAIL - 32, textGrowth: 'fixed-width' }));
railList = Insert(rail, {
  type: 'frame', name: 'T01 Rail List', layout: 'vertical', gap: 6,
  width: RAIL - 32, height: 'fill_container', clip: true
});
for (const n of [1, 2, 3, 4, 5, 6]) {
  Insert(railList, { type: 'ref', name: 'T01 Rail Item ' + n, ref: ids.SessionItem, width: RAIL - 32 });
}

chat = Insert(body, {
  type: 'frame', name: 'T01 Chat', layout: 'vertical', gap: 0,
  width: CHAT, height: H, fill: '$bg.primary', clip: true
});
bar = Insert(chat, {
  type: 'frame', name: 'T01 Chat Bar', layout: 'vertical', width: CHAT, height: BAR, clip: true
});
Insert(bar, { type: 'ref', name: 'T01 Chat TopBar', ref: ids.TopBar, width: CHAT });
tl = Insert(chat, {
  type: 'frame', name: 'T01 Chat Timeline', layout: 'vertical', gap: 12, padding: 16,
  width: CHAT, height: TLH, clip: true
});
Insert(tl, { type: 'ref', name: 'T01 Msg User', ref: ids.UserMessage, width: 300 });
Insert(tl, { type: 'ref', name: 'T01 Msg Assistant', ref: ids.AssistantMessage, width: CHAT - 32 });
Insert(tl, { type: 'ref', name: 'T01 Msg User 2', ref: ids.UserMessage, width: 280 });
Insert(tl, { type: 'ref', name: 'T01 Msg Assistant 2', ref: ids.AssistantMessage, width: CHAT - 32 });
foot = Insert(chat, {
  type: 'frame', name: 'T01 Chat Composer', layout: 'vertical', gap: 8, padding: 16,
  width: CHAT, height: FOOT, clip: true
});
Insert(foot, { type: 'ref', name: 'T01 Composer Inst', ref: ids.Composer, width: CHAT - 32 });
Insert(foot, T('T01 Tablet Note', 'Tablet: 768x1024, persistent rail + chat, same components and state semantics.',
  { fontSize: 10, fill: '$text.muted', width: CHAT - 32, textGrowth: 'fixed-width' }));

Print('tablet rebuilt');
Get((n, c) => { if (c.problems && /^T01/.test(n.name || '')) Print('CLIPPED', n.name, c.problems); });
Print('audit done');
