found = '';
Get((n) => { if (n.name === '02 Components') found = n.id; });
if (found === '') { throw new Error('02 Components frame not found'); }
more = Insert(found, {
  type: 'frame', name: 'Component Variants B', layout: 'vertical', gap: '$sp4',
  width: 560, fill: '$bg.secondary', cornerRadius: '$r3', padding: '$sp6'
});
const F = (name, over) => Object.assign({
  type: 'frame', name, layout: 'vertical', gap: '$sp2',
  fill: '$surface.primary', cornerRadius: '$r3',
  stroke: '$border.default', strokeWidth: 1, clip: true
}, over);
const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 15,
  fill: '$text.primary', textGrowth: 'fixed-width', width: 'fill_container'
}, over);
const I = (name, icon, over) => Object.assign({
  type: 'icon', name, library: 'lucide', icon, width: 20, height: 20, fill: '$text.secondary'
}, over);

Insert(more, T('Components B Heading', 'Shell, navigation and states', { fontSize: 18, fontWeight: '600' }));

appShell = Insert(more, F('AppShell', {
  reusable: true, layout: 'vertical', gap: 0, width: 'fill_container', height: 360,
  fill: '$bg.primary', cornerRadius: '$r3', padding: 0
}));
Insert(appShell, T('Shell Note', 'Composes TopBar + banner slot + content + composer', { fontSize: 12, fill: '$text.muted' }));

menuButton = Insert(more, F('MenuButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  width: '$touch', height: '$touch', fill: '$surface.secondary', cornerRadius: '$r2'
}));
Insert(menuButton, I('Menu Icon', 'menu', { width: 22, height: 22, fill: '$text.primary' }));

sessionDrawer = Insert(more, F('SessionDrawer', {
  reusable: true, layout: 'vertical', gap: '$sp3', width: '$drawerW', height: 420,
  fill: '$bg.secondary', cornerRadius: 0, padding: '$sp4'
}));
Insert(sessionDrawer, T('Drawer Title', 'DSH Remote', { fontSize: 20, fontWeight: '700' }));
Insert(sessionDrawer, T('Drawer New Session', '+ New session', {
  fontSize: 14, fontWeight: '600', fill: '$accent.primary', width: 'fit_content'
}));
Insert(sessionDrawer, T('Drawer New Session Note', 'Deferred — requires a session-create route', {
  fontSize: 11, fill: '$status.warning'
}));
Insert(sessionDrawer, T('Drawer Section', 'Sessions', { fontSize: 12, fill: '$text.muted', width: 'fit_content' }));

sessionList = Insert(more, F('SessionList', {
  reusable: true, layout: 'vertical', gap: '$sp2', width: 'fill_container', height: 260,
  fill: '$bg.secondary', cornerRadius: '$r2', padding: '$sp2'
}));
Insert(sessionList, T('SessionList Note', 'Scrollable list of SessionItem', { fontSize: 12, fill: '$text.muted' }));

newSessionButton = Insert(more, F('NewSessionButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  gap: '$sp2', width: 'fill_container', height: '$touch', fill: '$surface.secondary',
  cornerRadius: '$r2', stroke: '$border.strong'
}));
Insert(newSessionButton, I('New Session Icon', 'plus', { width: 18, height: 18, fill: '$text.muted' }));
Insert(newSessionButton, T('New Session Label', 'Available after session-create integration', {
  fontSize: 12, fill: '$text.muted', width: 'fit_content'
}));

messageTimeline = Insert(more, F('MessageTimeline', {
  reusable: true, layout: 'vertical', gap: '$sp3', width: 'fill_container', height: 320,
  fill: '$bg.primary', cornerRadius: '$r2', padding: '$sp3'
}));
Insert(messageTimeline, T('Timeline Note', 'Vertical stack of message components', { fontSize: 12, fill: '$text.muted' }));

uploadButton = Insert(more, F('UploadButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  width: '$touch', height: '$touch', fill: '$surface.secondary', cornerRadius: '$r2'
}));
Insert(uploadButton, I('Upload Icon', 'image-plus', { width: 22, height: 22, fill: '$text.secondary' }));

uploadProgressChip = Insert(more, F('UploadProgressChip', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fill_container', height: 40, fill: '$surface.secondary',
  cornerRadius: '$r2', padding: [8, 12]
}));
Insert(uploadProgressChip, I('Upload Progress Icon', 'loader', { width: 16, height: 16, fill: '$accent.primary' }));
Insert(uploadProgressChip, T('Upload Progress Label', 'uploading 62%', { fontSize: 12, fill: '$text.secondary', width: 'fill_container' }));

credentialDialog = Insert(more, F('CredentialDialog', {
  reusable: true, layout: 'vertical', gap: '$sp4', width: 340, height: 'fit_content',
  fill: '$surface.primary', cornerRadius: '$r4', padding: '$sp6', stroke: '$border.strong'
}));
Insert(credentialDialog, T('Credential Title', 'Connect to DSH', { fontSize: 20, fontWeight: '700' }));
Insert(credentialDialog, T('Credential Sub', 'Phone Access Token', { fontSize: 13, fill: '$text.secondary', width: 'fit_content' }));
credInput = Insert(credentialDialog, F('Credential Input', {
  layout: 'horizontal', alignItems: 'center', width: 'fill_container', height: '$touch',
  fill: '$bg.primary', cornerRadius: '$r2', padding: [8, 12], stroke: '$border.default'
}));
Insert(credInput, T('Credential Mask', '••••••••••••••••••••', {
  fontSize: 15, fontFamily: 'JetBrains Mono', fill: '$text.muted', width: 'fill_container'
}));
Insert(credInput, I('Credential Reveal', 'eye', { width: 18, height: 18, fill: '$text.muted' }));
credButton = Insert(credentialDialog, F('Credential Connect', {
  layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  width: 'fill_container', height: '$touch', fill: '$accent.primary', cornerRadius: '$r2'
}));
Insert(credButton, T('Credential Connect Label', 'Connect', {
  fontSize: 15, fontWeight: '600', fill: '$text.inverse', textAlign: 'center'
}));
Insert(credentialDialog, T('Credential Note', 'Stored in sessionStorage only. Never placed in a URL.', {
  fontSize: 11, fill: '$text.muted'
}));

loadingState = Insert(more, F('LoadingState', {
  reusable: true, layout: 'vertical', gap: '$sp2', width: 'fill_container', height: 'fit_content',
  fill: '$bg.secondary', cornerRadius: '$r2', padding: '$sp3'
}));
for (const n of [1, 2, 3]) {
  Insert(loadingState, {
    type: 'rectangle', name: 'Skeleton ' + n, width: 'fill_container', height: 16,
    cornerRadius: 6, fill: '$surface.secondary'
  });
}
