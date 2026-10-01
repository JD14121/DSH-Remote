ids = {};
Get((n) => { if (n.reusable === true && n.id) ids[n.name] = n.id; });

const F = (name, over) => Object.assign({
  type: 'frame', name, layout: 'vertical', gap: 8,
  fill: '$surface.primary', cornerRadius: '$r3', stroke: '$border.default', strokeWidth: 1
}, over);
const T = (name, content, over) => Object.assign({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: 12,
  fill: '$text.primary', textGrowth: 'fit_content'
}, over);

const flow = (parent, title, steps, deps) => {
  const col = Insert(parent, F(title, { width: 268, gap: 8, padding: 16 }));
  Insert(col, T(title + ' Title', title, { fontSize: 15, fontWeight: '700' }));
  let i = 1;
  for (const s of steps) {
    r = Insert(col, {
      type: 'frame', name: title + ' Step ' + i, layout: 'horizontal', alignItems: 'start', gap: 8,
      width: 'fill_container', height: 'fit_content'
    });
    Insert(r, {
      type: 'ellipse', name: title + ' Num ' + i, width: 18, height: 18, fill: '$surface.hover'
    });
    Insert(r, T(title + ' Step Text ' + i, s, { width: 210, textGrowth: 'fixed-width', fill: '$text.secondary' }));
    i = i + 1;
  }
  Insert(col, T(title + ' Deps', deps, { fontSize: 10, fill: '$text.muted', width: 236, textGrowth: 'fixed-width' }));
  return col;
};

flows = Insert(document, {
  type: 'frame', name: '05 Interaction Flows', layout: 'horizontal', gap: 20, padding: 40,
  fill: '$bg.primary', cornerRadius: 24, width: 'fit_content', height: 'fit_content'
});
Insert(flows, T('Flows Title', 'Interaction Flows', { fontSize: 32, fontWeight: '700' }));

flow(flows, 'Authentication', [
  'auth_required',
  'CredentialDialog — paste Phone Access Token',
  'Connect → GET /api/v1/health',
  'authenticated request: Authorization Bearer',
  'success: full health contract required, not 200 alone',
  'token never re-rendered, never in a URL'
], 'GET /api/v1/health (authenticated)');

flow(flows, 'Send / Queue', [
  'draft the message',
  'idle → primary action reads "Send"',
  'running → primary action reads "Send later"',
  'send → message QUEUED behind the running turn',
  'UserMessage variant queued + QueueIndicator text count',
  'failure → ErrorMessage inline, draft preserved'
], 'POST /api/v1/sessions/:id/messages');

flow(flows, 'Steer', [
  'session is running',
  'draft non-empty',
  'SteerButton visible: "Steer current task"',
  'explicit secondary action — never hidden',
  'POST with steer intent',
  'Toast restates what happened'
], 'POST messages with steer intent (reserved)');

flow(flows, 'Streaming', [
  'assistant_stream_start',
  'create ONE transient AssistantMessage',
  'assistant_stream_chunk → append to that SAME message',
  'caret marks the stream head',
  'assistant_stream_end → finalize, remove cursor',
  'never render each chunk as its own message'
], 'WS assistant_stream_*');

flow(flows, 'Reconnect / Replay', [
  'connection lost → ReconnectBanner',
  'history stays visible and scrollable',
  'draft preserved, send disabled',
  'POST /api/v1/auth/ws-ticket',
  'WS connect → hello → replay → replay_complete',
  'live; brief reconnected confirmation'
], 'POST /api/v1/auth/ws-ticket + WS');

flow(flows, 'Resync', [
  'gateway reports resync_required',
  '"Conversation changed while you were offline."',
  'one action: Reload conversation',
  'GET messages → reset local view',
  'obtain a new WS ticket',
  'reconnect; reload-failed variant on error'
], 'GET messages + ws-ticket');

flow(flows, 'Upload', [
  'UploadButton opens the picker',
  'AttachmentChip selected',
  'client pre-check: type and ≤ 25 MiB',
  'POST uploads → UploadProgressChip',
  'uploaded, or failed',
  'failed → remove and re-select (no assumed retry endpoint)'
], 'POST /api/v1/sessions/:id/uploads');

flow(flows, 'Cancel', [
  'running → CancelButton visible',
  'tap "Cancel run"',
  'POST cancel',
  'message marked cancelled, partial text retained',
  'composer returns to idle',
  'failure → Toast, button re-enabled'
], 'POST /api/v1/sessions/:id/cancel');
