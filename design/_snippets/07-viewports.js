ids = {};
Get((n) => { if (n.reusable === true && n.id) ids[n.name] = n.id; });

board = '';
Get((n) => { if (n.name === '03 Mobile Screens') board = n.id; });
if (board === '') { throw new Error('03 Mobile Screens not found'); }

const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 13,
  fill: '$text.primary', textGrowth: 'fit_content'
}, over);

const readyChat = (label, w, h, note) => {
  const col = Insert(board, {
    type: 'frame', name: label, layout: 'vertical', gap: 16,
    width: 'fit_content', height: 'fit_content', fill: '#0B0D11', clip: false
  });
  Insert(col, T(label + ' Label', label + ' — ' + w + 'x' + h, { fontSize: 14, fontWeight: '600', fill: '#7E8698' }));
  const body = Insert(col, {
    type: 'frame', name: label + ' Body', layout: 'vertical', gap: 0,
    width: w, height: h, fill: '$bg.primary', cornerRadius: 16, clip: true,
    stroke: '#2A3140', strokeWidth: 1
  });
  const bar = Insert(body, {
    type: 'frame', name: label + ' Bar', layout: 'vertical',
    width: 'fill_container', height: 56, clip: true
  });
  Insert(bar, { type: 'ref', name: label + ' TopBar', ref: ids.TopBar, width: 'fill_container' });
  const tl = Insert(body, {
    type: 'frame', name: label + ' Timeline', layout: 'vertical', gap: 12, padding: 16,
    width: 'fill_container', height: 'fill_container', clip: true
  });
  Insert(tl, { type: 'ref', name: label + ' Msg User', ref: ids.UserMessage, width: Math.round(w * 0.72) });
  Insert(tl, { type: 'ref', name: label + ' Msg Assistant', ref: ids.AssistantMessage, width: 'fill_container' });
  Insert(tl, { type: 'ref', name: label + ' Msg Assistant 2', ref: ids.AssistantMessage, width: 'fill_container' });
  const foot = Insert(body, {
    type: 'frame', name: label + ' Composer', layout: 'vertical', gap: 8, padding: 12,
    width: 'fill_container', height: 'fit_content', clip: true
  });
  Insert(foot, { type: 'ref', name: label + ' Composer Inst', ref: ids.Composer, width: 'fill_container' });
  Insert(foot, T(label + ' Note', note, { fontSize: 10, fill: '$text.muted', width: w - 40, textGrowth: 'fixed-width' }));
  return body;
};

readyChat('V360 Ready Chat', 360, 800, '360x800 — narrowest. Check the composer row and 85% message cap.');
readyChat('V430 Ready Chat', 430, 932, '430x932 — widest phone. Check line length and the 85% cap.');

Print('viewport compositions created');
