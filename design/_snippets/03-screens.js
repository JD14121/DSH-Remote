ids = {
  TopBar: 'iXS3H',
  ConnectionBadge: 'l6iKrJ',
  UserMessage: 'A1oaP8',
  AssistantMessage: 'AN5qn',
  CodeBlock: 'jH8Ac',
  SystemMessage: 'CRcAm',
  ErrorMessage: 'TKA9E',
  Composer: 'OpoWj',
  ComposerTextArea: 'VlRvj',
  SendButton: 'O0f73b',
  SteerButton: 'eigOA',
  CancelButton: 'r3bqQq',
  QueueIndicator: 'J6Vsr',
  WaitingInputIndicator: 'nVbtG',
  StreamingIndicator: 'xIXgs',
  ReconnectBanner: 'I1WnIf',
  ResyncBanner: 'PpWWD',
  AttachmentChip: 'u7sPnK',
  SessionItem: 'BgYNx',
  EmptyState: 'mIVLe',
  FatalErrorState: 'wQjyn',
  Toast: 'UGq0d',
  AppShell: 'uD2IT',
  MenuButton: 'yAR9w',
  SessionDrawer: 'eEiC7',
  SessionList: 'Z9ev3R',
  NewSessionButton: 'dl1br',
  MessageTimeline: 'Q2UgZ',
  UploadButton: 'ZL0Pl',
  UploadProgressChip: 'dCkek',
  CredentialDialog: 'XKxxZ',
  LoadingState: 'vxCKv'
};

screensRoot = Insert(document, {
  type: 'frame', name: '03 Mobile Screens', layout: 'horizontal', gap: 48,
  padding: 48, fill: '#0B0D11', cornerRadius: 24, clip: true,
  width: 'fit_content', height: 'fit_content'
});

const screen = (title, w, h) => {
  const col = Insert(screensRoot, {
    type: 'frame', name: title, layout: 'vertical', gap: 16,
    width: 'fit_content', height: 'fit_content', fill: '#0B0D11', clip: true
  });
  Insert(col, {
    type: 'text', name: title + ' Label', content: title, fontFamily: 'Inter',
    fontSize: 14, fontWeight: '600', fill: '#7E8698'
  });
  const body = Insert(col, {
    type: 'frame', name: title + ' Body', layout: 'vertical', gap: 0,
    width: w, height: h, fill: '$bg.primary', cornerRadius: 16, clip: true,
    stroke: '#2A3140', strokeWidth: 1
  });
  return body;
};

const inst = (parent, name, component, over) => {
  const target = ids[component];
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('missing component id for: ' + String(component));
  }
  return Insert(parent, Object.assign({ type: 'ref', name, ref: target }, over || {}));
};

const bar = (parent, name, title, over) => {
  const holder = Insert(parent, Object.assign({
    type: 'frame', name, layout: 'vertical', width: 390, height: 56, clip: true, gap: 0
  }, over || {}));
  inst(holder, name + ' TopBar', 'TopBar', { width: 390 });
  return holder;
};

const row = (parent, name, over) => Insert(parent, Object.assign({
  type: 'frame', name, layout: 'vertical', gap: 8, padding: 16,
  width: 'fill_container', height: 'fill_container', clip: true
}, over || {}));

const bottom = (parent, name, over) => {
  const holder = Insert(parent, Object.assign({
    type: 'frame', name, layout: 'vertical', gap: 8, padding: 12,
    width: 390, height: 'fit_content', clip: true
  }, over || {}));
  return holder;
};

s01 = screen('S01 Ready Chat', 390, 844);
bar(s01, 'S01 Bar', 'Ready Chat');
body01 = row(s01, 'S01 Timeline');
inst(body01, 'S01 User', 'UserMessage', { width: 300 });
inst(body01, 'S01 Assistant', 'AssistantMessage', { width: 'fill_container' });
inst(body01, 'S01 Assistant 2', 'AssistantMessage', { width: 'fill_container' });
foot01 = bottom(s01, 'S01 Composer');
inst(foot01, 'S01 Composer Inst', 'Composer', { width: 390 });

s02 = screen('S02 Assistant Streaming', 390, 844);
bar(s02, 'S02 Bar', 'Assistant Streaming');
body02 = row(s02, 'S02 Timeline');
inst(body02, 'S02 User', 'UserMessage', { width: 300 });
inst(body02, 'S02 Streaming', 'AssistantMessage', { width: 'fill_container' });
inst(body02, 'S02 Cursor', 'StreamingIndicator', {});
row02 = Insert(s02, {
  type: 'frame', name: 'S02 Actions', layout: 'horizontal', gap: 8, padding: [0, 16],
  width: 390, height: 'fit_content'
});
inst(row02, 'S02 Cancel', 'CancelButton', {});
foot02 = bottom(s02, 'S02 Composer');
inst(foot02, 'S02 Composer Inst', 'Composer', { width: 390 });
insert02 = Insert(foot02, {
  type: 'frame', name: 'S02 Send Stack', layout: 'horizontal', gap: 8,
  width: 'fill_container', height: 'fit_content'
});
inst(insert02, 'S02 Steer', 'SteerButton', {});
Insert(insert02, {
  type: 'text', name: 'S02 Send Note', content: 'Primary action reads "Send later" while running',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width',
  width: 240
});

s03 = screen('S03 Message Queued', 390, 844);
bar(s03, 'S03 Bar', 'Message Queued');
body03 = row(s03, 'S03 Timeline');
inst(body03, 'S03 User', 'UserMessage', { width: 300 });
inst(body03, 'S03 Assistant', 'AssistantMessage', { width: 'fill_container' });
inst(body03, 'S03 Queued User', 'UserMessage', { width: 300 });
foot03 = bottom(s03, 'S03 Composer');
inst(foot03, 'S03 Queue', 'QueueIndicator', {});
inst(foot03, 'S03 Composer Inst', 'Composer', { width: 390 });
Insert(foot03, {
  type: 'text', name: 'S03 Note', content: 'Queued message is marked; label stays "Send later"',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

s04 = screen('S04 Waiting for Input', 390, 844);
bar(s04, 'S04 Bar', 'Waiting for Input');
body04 = row(s04, 'S04 Timeline');
inst(body04, 'S04 Assistant', 'AssistantMessage', { width: 'fill_container' });
foot04 = bottom(s04, 'S04 Composer');
inst(foot04, 'S04 Waiting', 'WaitingInputIndicator', { width: 366 });
inst(foot04, 'S04 Composer Inst', 'Composer', { width: 390 });
Insert(foot04, {
  type: 'text', name: 'S04 Note', content: 'Composer emphasized; primary action is a plain reply',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

s05 = screen('S05 Reconnecting', 390, 844);
bar(s05, 'S05 Bar', 'Reconnecting');
inst(s05, 'S05 Banner', 'ReconnectBanner', { width: 390 });
body05 = row(s05, 'S05 Timeline');
inst(body05, 'S05 User', 'UserMessage', { width: 300 });
inst(body05, 'S05 Assistant', 'AssistantMessage', { width: 'fill_container' });
foot05 = bottom(s05, 'S05 Composer');
inst(foot05, 'S05 Composer Inst', 'Composer', { width: 390 });
Insert(foot05, {
  type: 'text', name: 'S05 Note', content: 'History retained and scrollable; send disabled; draft preserved',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

s06 = screen('S06 Resync Required', 390, 844);
bar(s06, 'S06 Bar', 'Resync Required');
inst(s06, 'S06 Banner', 'ResyncBanner', { width: 390 });
body06 = row(s06, 'S06 Timeline');
inst(body06, 'S06 Empty', 'EmptyState', { width: 'fill_container' });
Insert(body06, {
  type: 'text', name: 'S06 Note', content: 'Four sub-states designed: before reload, loading, reloaded, reload failed',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

s07 = screen('S07 Session Drawer Open', 390, 844);
bar(s07, 'S07 Bar', 'Session Drawer Open');
body07 = Insert(s07, {
  type: 'frame', name: 'S07 Backdrop', layout: 'horizontal', gap: 0,
  width: 390, height: 'fill_container', fill: '$overlay', clip: true
});
drawer = Insert(body07, {
  type: 'frame', name: 'S07 Drawer Column', layout: 'vertical', gap: 8,
  width: 300, height: 'fill_container', fill: '$bg.secondary', clip: true
});
inst(drawer, 'S07 Drawer Head', 'SessionDrawer', { width: 300, height: 'fit_content' });
list07 = Insert(drawer, {
  type: 'frame', name: 'S07 List', layout: 'vertical', gap: 4, padding: 8,
  width: 'fill_container', height: 'fill_container', clip: true
});
for (const n of [1, 2, 3, 4, 5]) {
  inst(list07, 'S07 Item ' + n, 'SessionItem', { width: 'fill_container' });
}

s08 = screen('S08 File Upload', 390, 844);
bar(s08, 'S08 Bar', 'File Upload');
body08 = row(s08, 'S08 Timeline');
inst(body08, 'S08 User', 'UserMessage', { width: 300 });
inst(body08, 'S08 Assistant', 'AssistantMessage', { width: 'fill_container' });
foot08 = bottom(s08, 'S08 Composer');
chips08 = Insert(foot08, {
  type: 'frame', name: 'S08 Chips', layout: 'horizontal', gap: 8,
  width: 'fill_container', height: 'fit_content'
});
inst(chips08, 'S08 Attachment', 'AttachmentChip', {});
inst(foot08, 'S08 Progress', 'UploadProgressChip', { width: 366 });
inst(foot08, 'S08 Composer Inst', 'Composer', { width: 390 });
Insert(foot08, {
  type: 'text', name: 'S08 Note', content: 'Client pre-checks 25 MiB; server remains the authority',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

s09 = screen('S09 Phone Token Authentication', 390, 844);
body09 = Insert(s09, {
  type: 'frame', name: 'S09 Center', layout: 'vertical', alignItems: 'center',
  justifyContent: 'center', padding: 24, width: 'fill_container', height: 'fill_container',
  fill: '$bg.primary'
});
inst(body09, 'S09 Dialog', 'CredentialDialog', {});
Insert(body09, {
  type: 'text', name: 'S09 Note', content: 'Token never in a URL, never re-rendered, never in localStorage',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 340, textAlign: 'center'
});

s10 = screen('S10 Gateway Unavailable', 390, 844);
bar(s10, 'S10 Bar', 'Gateway Unavailable');
body10 = row(s10, 'S10 Body', { justifyContent: 'center' });
inst(body10, 'S10 Fatal', 'FatalErrorState', { width: 'fill_container' });
Insert(body10, {
  type: 'text', name: 'S10 Note', content: 'No lifecycle control is offered: the operator manages DSH and the Gateway',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 340
});

s11 = screen('S11 Empty Session', 390, 844);
bar(s11, 'S11 Bar', 'Empty Session');
body11 = row(s11, 'S11 Body', { justifyContent: 'center' });
inst(body11, 'S11 Empty', 'EmptyState', { width: 'fill_container' });
foot11 = bottom(s11, 'S11 Composer');
inst(foot11, 'S11 Composer Inst', 'Composer', { width: 390 });

s12 = screen('S12 Failed Message', 390, 844);
bar(s12, 'S12 Bar', 'Failed Message');
body12 = row(s12, 'S12 Timeline');
inst(body12, 'S12 User', 'UserMessage', { width: 300 });
inst(body12, 'S12 Error', 'ErrorMessage', { width: 'fill_container' });
foot12 = bottom(s12, 'S12 Composer');
inst(foot12, 'S12 Composer Inst', 'Composer', { width: 390 });
Insert(foot12, {
  type: 'text', name: 'S12 Note', content: 'Draft preserved; retry does not duplicate the message',
  fontFamily: 'Inter', fontSize: 11, fill: '$text.muted', textGrowth: 'fixed-width', width: 350
});

Print('screens built:', 12);
