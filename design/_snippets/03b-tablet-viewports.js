Get((n) => { if (n.name === 'T01 Tablet Ready Chat') Delete(n.id); });
Get((n) => { if (n.name === 'V360 Ready Chat') Delete(n.id); });
Get((n) => { if (n.name === 'V430 Ready Chat') Delete(n.id); });
Print('removed previous attempts');

ids = {};
Get((n) => { if (n.reusable === true && n.id) ids[n.name] = n.id; });

const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 12,
  fill: '$text.primary', textGrowth: 'fit_content'
}, over);

area = Insert(document, {
  type: 'frame', name: '03b Tablet & Viewports', layout: 'horizontal', gap: 48, padding: 48,
  fill: '#0B0D11', cornerRadius: 24, width: 'fit_content', height: 'fit_content'
});
Insert(area, T('03b Title', 'Tablet & Viewport Compositions', { fontSize: 24, fontWeight: '700' }));

const screen = (labelText, w, h) => {
  const col = Insert(area, {
    type: 'frame', name: labelText, layout: 'vertical', gap: 16,
    width: 'fit_content', height: 'fit_content', fill: '#0B0D11'
  });
  Insert(col, T(labelText + ' Label', labelText + ' — ' + w + 'x' + h, { fontSize: 14, fontWeight: '600', fill: '#7E8698' }));
  return Insert(col, {
    type: 'frame', name: labelText + ' Body', layout: 'vertical', gap: 0,
    width: w, height: h, fill: '$bg.primary', cornerRadius: 16, clip: true,
    stroke: '#2A3140', strokeWidth: 1
  });
};

const mobileReady = (labelText, w, h) => {
  const body = screen(labelText, w, h);
  bar = Insert(body, {
    type: 'frame', name: labelText + ' Bar', layout: 'vertical', width: w, height: 56, clip: true
  });
  Insert(bar, { type: 'ref', name: labelText + ' TopBar', ref: ids.TopBar, width: w });
  tl = Insert(body, {
    type: 'frame', name: labelText + ' Timeline', layout: 'vertical', gap: 12, padding: 16,
    width: w, height: h - 140, clip: true
  });
  Insert(tl, { type: 'ref', name: labelText + ' Msg User', ref: ids.UserMessage, width: Math.round(w * 0.72) });
  Insert(tl, { type: 'ref', name: labelText + ' Msg Assistant', ref: ids.AssistantMessage, width: w - 32 });
  Insert(tl, { type: 'ref', name: labelText + ' Msg Assistant 2', ref: ids.AssistantMessage, width: w - 32 });
  foot = Insert(body, {
    type: 'frame', name: labelText + ' Composer', layout: 'vertical', gap: 8, padding: 12,
    width: w, height: 84, clip: true
  });
  Insert(foot, { type: 'ref', name: labelText + ' Composer Inst', ref: ids.Composer, width: w - 24 });
};

mobileReady('V360 Ready Chat', 360, 800);
mobileReady('V430 Ready Chat', 430, 932);

const W = 768;
const H = 1024;
const RAIL = 300;
const CHATW = W - RAIL;

tbody = screen('T01 Tablet Ready Chat', W, H);

rail = Insert(tbody, {
  type: 'frame', name: 'T01 Rail', layout: 'vertical', gap: 12,
  width: RAIL, height: H, fill: '$bg.secondary', padding: 16, clip: true
});
Insert(rail, { type: 'ref', name: 'T01 Rail Drawer', ref: ids.SessionDrawer, width: RAIL - 32 });
Insert(rail, T('T01 Rail Note', 'Persistent rail — same components as mobile, layout only.',
  { fontSize: 10, fill: '$text.muted', width: RAIL - 32, textGrowth: 'fixed-width' }));
railList = Insert(rail, {
  type: 'frame', name: 'T01 Rail List', layout: 'vertical', gap: 6,
  width: RAIL - 32, height: 500, clip: true
});
for (const n of [1, 2, 3, 4, 5, 6]) {
  Insert(railList, { type: 'ref', name: 'T01 Rail Item ' + n, ref: ids.SessionItem, width: RAIL - 32 });
}

chat = Insert(tbody, {
  type: 'frame', name: 'T01 Chat', layout: 'vertical', gap: 0,
  width: CHATW, height: H, fill: '$bg.primary'
});
bar2 = Insert(chat, {
  type: 'frame', name: 'T01 Chat Bar', layout: 'vertical', width: CHATW, height: 56, clip: true
});
Insert(bar2, { type: 'ref', name: 'T01 Chat TopBar', ref: ids.TopBar, width: CHATW });
tl2 = Insert(chat, {
  type: 'frame', name: 'T01 Chat Timeline', layout: 'vertical', gap: 12, padding: 16,
  width: CHATW, height: 800, clip: true
});
Insert(tl2, { type: 'ref', name: 'T01 Msg User', ref: ids.UserMessage, width: 300 });
Insert(tl2, { type: 'ref', name: 'T01 Msg Assistant', ref: ids.AssistantMessage, width: CHATW - 32 });
Insert(tl2, { type: 'ref', name: 'T01 Msg User 2', ref: ids.UserMessage, width: 280 });
Insert(tl2, { type: 'ref', name: 'T01 Msg Assistant 2', ref: ids.AssistantMessage, width: CHATW - 32 });
foot2 = Insert(chat, {
  type: 'frame', name: 'T01 Chat Composer', layout: 'vertical', gap: 8, padding: 16,
  width: CHATW, height: 168, clip: true
});
Insert(foot2, { type: 'ref', name: 'T01 Composer Inst', ref: ids.Composer, width: CHATW - 32 });
Insert(foot2, T('T01 Tablet Note', 'Tablet: persistent rail + chat, same component hierarchy and state semantics.',
  { fontSize: 10, fill: '$text.muted', width: CHATW - 32, textGrowth: 'fixed-width' }));

Print('tablet and viewports built in their own area');
