const F = (name, over) => Object.assign({
  type: 'frame', name, layout: 'vertical', gap: '$sp2',
  fill: '$surface.primary', cornerRadius: '$r3',
  stroke: '$border.default', strokeWidth: 1, clip: true
}, over);
const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 15,
  fill: '$text.primary', textGrowth: 'fixed-width', width: 'fill_container'
}, over);
const R = (name, over) => Object.assign({
  type: 'rectangle', name, fill: '$surface.secondary', cornerRadius: '$r2'
}, over);
const I = (name, icon, over) => Object.assign({
  type: 'icon', name, library: 'lucide', icon, width: 20, height: 20, fill: '$text.secondary'
}, over);

components = Insert(document, {
  type: 'frame', name: '02 Components', layout: 'horizontal', gap: '$sp6',
  padding: '$sp8', fill: '$bg.primary', cornerRadius: 24, clip: true,
  width: 'fit_content', height: 'fit_content'
});

const variants = Insert(components, {
  type: 'frame', name: 'Component Variants', layout: 'vertical', gap: '$sp4',
  width: 560, fill: '$bg.secondary', cornerRadius: '$r3', padding: '$sp6'
});
Insert(variants, T('Components Heading', 'Reusable components', { fontSize: 24, fontWeight: '700' }));
Insert(variants, T('Components Sub', 'Each component is reusable; screens instance them.', { fontSize: 13, fill: '$text.muted' }));

topBar = Insert(variants, F('TopBar', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fill_container', height: '$topbarH', padding: ['$sp3', '$sp4'], cornerRadius: 0
}));
Insert(topBar, I('TopBar Menu', 'menu', { width: 20, height: 20, fill: '$text.primary' }));
Insert(topBar, T('TopBar Title', 'DSH Remote', { fontSize: 17, fontWeight: '600' }));
Insert(topBar, { type: 'frame', name: 'TopBar Spacer', layout: 'horizontal', width: 'fill_container', height: 1 });
topBarBadge = Insert(topBar, F('ConnectionBadge', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fit_content', height: 28, padding: ['$sp2', '$sp3'],
  fill: '$surface.secondary', cornerRadius: '$rPill'
}));
Insert(topBarBadge, { type: 'ellipse', name: 'Badge Dot', width: 8, height: 8, fill: '$status.success' });
Insert(topBarBadge, T('Badge Label', 'Ready', { fontSize: 12, fontWeight: '600', width: 'fit_content' }));

userMessage = Insert(variants, F('UserMessage', {
  reusable: true, layout: 'vertical', gap: '$sp1', width: 'fit_content', height: 'fit_content',
  fill: '$message.user', cornerRadius: '$r3', padding: '$sp3', stroke: '$border.default'
}));
Insert(userMessage, T('UserMessage Text', 'Summarise the failing test output.', { fontSize: 15 }));

assistantMessage = Insert(variants, F('AssistantMessage', {
  reusable: true, layout: 'vertical', gap: '$sp2', width: 'fill_container', height: 'fit_content',
  fill: '$message.assistant', cornerRadius: '$r3', padding: '$sp3', stroke: '$border.default'
}));
Insert(assistantMessage, T('AssistantMessage Text', 'The suite is green: 1068 tests, 0 failures.', { fontSize: 15 }));
assistantCode = Insert(assistantMessage, F('CodeBlock', {
  reusable: true, layout: 'vertical', gap: '$sp2', width: 'fill_container', clip: true,
  fill: '$bg.secondary', cornerRadius: '$r2', padding: '$sp3', stroke: '$border.default'
}));
codeHead = Insert(assistantCode, {
  type: 'frame', name: 'Code Head', layout: 'horizontal', alignItems: 'center',
  gap: '$sp2', width: 'fill_container', height: 24
});
Insert(codeHead, T('Code Lang', 'bash', { fontSize: 12, fontFamily: 'JetBrains Mono', fill: '$text.muted', width: 'fill_container' }));
Insert(codeHead, I('Code Copy', 'copy', { width: 20, height: 20, fill: '$text.secondary' }));
Insert(assistantCode, T('Code Line', 'npm test -- --test-name-pattern "supervisor"', {
  fontSize: 13, fontFamily: 'JetBrains Mono', fill: '$text.secondary'
}));

systemMessage = Insert(variants, F('SystemMessage', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  width: 'fill_container', height: 'fit_content', fill: '$message.system',
  cornerRadius: '$rPill', padding: ['$sp2', '$sp3'], stroke: '$border.default'
}));
Insert(systemMessage, T('SystemMessage Text', 'Session started', { fontSize: 12, fill: '$text.muted', textAlign: 'center' }));

errorMessage = Insert(variants, F('ErrorMessage', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fill_container', height: 'fit_content', fill: '$surface.primary',
  cornerRadius: '$r3', padding: '$sp3', stroke: '$status.danger', strokeWidth: 1
}));
Insert(errorMessage, I('Error Icon', 'alert-triangle', { fill: '$status.danger' }));
errorBody = Insert(errorMessage, { type: 'frame', name: 'Error Body', layout: 'vertical', gap: 2, width: 'fill_container', height: 'fit_content' });
Insert(errorBody, T('Error Title', 'Message not sent', { fontSize: 15, fontWeight: '600' }));
Insert(errorBody, T('Error Detail', 'The connection dropped. Your draft is saved.', { fontSize: 12, fill: '$text.muted' }));
Insert(errorMessage, { type: 'text', name: 'Error Retry', content: 'Retry', fontFamily: 'Inter', fontSize: 13, fontWeight: '600', fill: '$accent.primary', width: 'fit_content' });

composer = Insert(variants, F('Composer', {
  reusable: true, layout: 'horizontal', alignItems: 'end', gap: '$sp2',
  width: 'fill_container', height: 'fit_content', fill: '$surface.primary',
  cornerRadius: '$r3', padding: '$sp3', stroke: '$border.default'
}));
Insert(composer, I('Composer Upload', 'paperclip', { width: 24, height: 24, fill: '$text.secondary' }));
composerField = Insert(composer, F('ComposerTextArea', {
  reusable: true, layout: 'vertical', width: 'fill_container', height: 'fit_content',
  fill: '$surface.secondary', cornerRadius: '$r2', padding: '$sp3', stroke: '$surface.secondary'
}));
Insert(composerField, T('Composer Placeholder', 'Message DSH', { fontSize: 15, fill: '$text.muted' }));
sendButton = Insert(composer, F('SendButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  width: '$touch', height: '$touch', fill: '$accent.primary', cornerRadius: '$r2'
}));
Insert(sendButton, I('Send Icon', 'arrow-up', { width: 20, height: 20, fill: '$text.inverse' }));

steerButton = Insert(variants, F('SteerButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  gap: '$sp2', width: 'fit_content', height: '$touch', padding: [0, '$sp4'],
  fill: '$surface.secondary', cornerRadius: '$r2', stroke: '$border.strong'
}));
Insert(steerButton, I('Steer Icon', 'git-branch', { width: 18, height: 18, fill: '$text.primary' }));
Insert(steerButton, T('Steer Label', 'Steer current task', { fontSize: 14, fontWeight: '600', width: 'fit_content' }));

cancelButton = Insert(variants, F('CancelButton', {
  reusable: true, layout: 'horizontal', alignItems: 'center', justifyContent: 'center',
  gap: '$sp2', width: 'fit_content', height: '$touch', padding: [0, '$sp4'],
  fill: '$surface.primary', cornerRadius: '$r2', stroke: '$status.danger'
}));
Insert(cancelButton, I('Cancel Icon', 'square', { width: 16, height: 16, fill: '$status.danger' }));
Insert(cancelButton, T('Cancel Label', 'Cancel run', { fontSize: 14, fontWeight: '600', fill: '$status.danger', width: 'fit_content' }));

queueIndicator = Insert(variants, F('QueueIndicator', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fit_content', height: 28, padding: ['$sp1', '$sp3'],
  fill: '$surface.secondary', cornerRadius: '$rPill'
}));
Insert(queueIndicator, I('Queue Icon', 'list', { width: 14, height: 14, fill: '$text.muted' }));
Insert(queueIndicator, T('Queue Label', '2 queued', { fontSize: 12, fill: '$text.secondary', width: 'fit_content' }));

waitingIndicator = Insert(variants, F('WaitingInputIndicator', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fill_container', height: 36, padding: ['$sp1', '$sp3'],
  fill: '$surface.secondary', cornerRadius: '$r2', stroke: '$status.info'
}));
Insert(waitingIndicator, I('Waiting Icon', 'help-circle', { width: 16, height: 16, fill: '$status.info' }));
Insert(waitingIndicator, T('Waiting Label', 'DSH is waiting for your answer', { fontSize: 13, fill: '$text.primary', width: 'fill_container' }));

streamingIndicator = Insert(variants, F('StreamingIndicator', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fit_content', height: 24, fill: '$bg.secondary', cornerRadius: '$rPill', padding: ['$sp1', '$sp3']
}));
Insert(streamingIndicator, { type: 'ellipse', name: 'Stream Dot', width: 8, height: 8, fill: '$accent.primary' });
Insert(streamingIndicator, T('Stream Label', 'Responding…', { fontSize: 12, fill: '$text.secondary', width: 'fit_content' }));

reconnectBanner = Insert(variants, F('ReconnectBanner', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fill_container', height: '$bannerH', padding: [0, '$sp4'],
  fill: '$surface.secondary', cornerRadius: 0, stroke: '$status.warning'
}));
Insert(reconnectBanner, I('Reconnect Icon', 'wifi-off', { width: 16, height: 16, fill: '$status.warning' }));
Insert(reconnectBanner, T('Reconnect Label', 'Reconnecting… your history is safe', { fontSize: 13, fill: '$text.primary', width: 'fill_container' }));

resyncBanner = Insert(variants, F('ResyncBanner', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fill_container', height: 56, padding: ['$sp2', '$sp4'],
  fill: '$surface.secondary', cornerRadius: 0, stroke: '$status.warning'
}));
Insert(resyncBanner, I('Resync Icon', 'refresh-cw', { width: 16, height: 16, fill: '$status.warning' }));
Insert(resyncBanner, T('Resync Label', 'Conversation changed while you were offline.', { fontSize: 13, fill: '$text.primary', width: 'fill_container' }));
Insert(resyncBanner, T('Resync Action', 'Reload', { fontSize: 13, fontWeight: '600', fill: '$accent.primary', width: 'fit_content' }));

attachmentChip = Insert(variants, F('AttachmentChip', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp2',
  width: 'fit_content', height: 40, padding: ['$sp1', '$sp3'],
  fill: '$surface.secondary', cornerRadius: '$r2', stroke: '$border.default'
}));
Insert(attachmentChip, I('Attachment Icon', 'image', { width: 16, height: 16, fill: '$text.muted' }));
Insert(attachmentChip, T('Attachment Name', 'diagram.png', { fontSize: 12, fill: '$text.primary', width: 'fit_content' }));
Insert(attachmentChip, I('Attachment Remove', 'x', { width: 14, height: 14, fill: '$text.muted' }));

sessionItem = Insert(variants, F('SessionItem', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fill_container', height: 56, padding: ['$sp2', '$sp3'],
  fill: '$surface.primary', cornerRadius: '$r2', stroke: '$border.default'
}));
Insert(sessionItem, I('Session Icon', 'message-square', { width: 18, height: 18, fill: '$text.muted' }));
sessionBody = Insert(sessionItem, { type: 'frame', name: 'Session Body', layout: 'vertical', gap: 2, width: 'fill_container', height: 'fit_content' });
Insert(sessionBody, T('Session Title', 'Refactor the supervisor stop path', { fontSize: 14, fontWeight: '600' }));
Insert(sessionBody, T('Session Meta', 'running · 2 min ago', { fontSize: 11, fill: '$text.muted' }));
Insert(sessionItem, { type: 'ellipse', name: 'Session Status', width: 8, height: 8, fill: '$status.success' });

emptyState = Insert(variants, F('EmptyState', {
  reusable: true, layout: 'vertical', alignItems: 'center', justifyContent: 'center',
  gap: '$sp3', width: 'fill_container', height: 200, fill: '$bg.secondary',
  cornerRadius: '$r3', padding: '$sp6'
}));
Insert(emptyState, I('Empty Icon', 'inbox', { width: 32, height: 32, fill: '$text.muted' }));
Insert(emptyState, T('Empty Title', 'No messages yet', { fontSize: 17, fontWeight: '600', textAlign: 'center' }));
Insert(emptyState, T('Empty Body', 'Send the first message to start this session.', { fontSize: 13, fill: '$text.muted', textAlign: 'center' }));

fatalState = Insert(variants, F('FatalErrorState', {
  reusable: true, layout: 'vertical', alignItems: 'center', justifyContent: 'center',
  gap: '$sp3', width: 'fill_container', height: 260, fill: '$bg.secondary',
  cornerRadius: '$r3', padding: '$sp6', stroke: '$status.danger'
}));
Insert(fatalState, I('Fatal Icon', 'server-off', { width: 36, height: 36, fill: '$status.danger' }));
Insert(fatalState, T('Fatal Title', 'Gateway unavailable', { fontSize: 20, fontWeight: '700', textAlign: 'center' }));
Insert(fatalState, T('Fatal Body', 'The operator must start the Gateway on the PC. This app cannot do it.', { fontSize: 13, fill: '$text.muted', textAlign: 'center' }));

toast = Insert(variants, F('Toast', {
  reusable: true, layout: 'horizontal', alignItems: 'center', gap: '$sp3',
  width: 'fit_content', height: 44, padding: ['$sp2', '$sp4'],
  fill: '$surface.secondary', cornerRadius: '$r2', stroke: '$border.strong'
}));
Insert(toast, I('Toast Icon', 'check-circle', { width: 16, height: 16, fill: '$status.success' }));
Insert(toast, T('Toast Label', 'Steered the current task', { fontSize: 13, fill: '$text.primary', width: 'fit_content' }));
