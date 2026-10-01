// Presentation of the documented DSH blocks; unknown structures stay opaque.
const blocks = value => Array.isArray(value) ? value : Array.isArray(value?.content) ? value.content : [];
const textBlocks = value => blocks(value).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
export function extractActivities(raw) {
  const value = raw.content;
  const result = [];
  for (const block of blocks(value)) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') result.push({kind:'reasoning',text:block.text});
    if (block?.type === 'tool-call') result.push({kind:'tool',callId:block.id,name:block.name,arguments:block.arguments,status:'preparing'});
  }
  if (raw.event_type === 'tool/call') result.push({kind:'tool',callId:raw.call_id,name:value?.name,arguments:value?.arguments,status:'running'});
  if (raw.event_type === 'tool/result') {
    for (const block of blocks(value?.message)) {
      if (block?.type === 'tool-result') result.push({kind:'result',callId:block.toolCallId ?? block.callId ?? block.id,
        status:block.isError === true || value?.ok === false ? 'failed' : 'completed',text:textBlocks(block.content)});
    }
  }
  return result;
}

export function groupRunMessages(messages) {
  const out = [], groups = new Map(), requests = new Map();
  const durable = new Set(messages.filter(m => m.role === 'assistant' && !m.id?.startsWith('stream:') && Number.isSafeInteger(m.turn))
    .map(m => `${m.sessionId}:${m.turn}:${m.step}`));
  for (const m of messages) {
    const sessionId = m.sessionId ?? m.session_id ?? '';
    if (m.role === 'user' && (!m.sourceKind || m.sourceKind === 'user') && m.content) {
      requests.set(sessionId, requestsMarkdown(m.content));
    }
    if (!Number.isSafeInteger(m.turn) || !['assistant','tool','system'].includes(m.role)) {
      out.push(m.role === 'assistant'
        ? {...m, markdownRequested:requests.get(sessionId) === true, activitySources:[m]} : m);
      continue;
    }
    const key = `${sessionId}:${m.turn}`;
    let g = groups.get(key);
    if (!g) { g = {key,rows:[],placed:false}; groups.set(key,g); }
    g.start ??= m.turnStartedAt ?? (m.eventType === 'turn/start' ? m.createdAt : null);
    g.end ??= m.turnEndedAt ?? (m.eventType === 'turn/end' ? m.createdAt : null);
    if (m.role === 'system') continue;
    g.markdownRequested ??= requests.get(sessionId) === true;
    if (!g.placed) { out.push(g); g.placed=true; }
    if (m.id?.startsWith('stream:') && durable.has(`${m.sessionId}:${m.turn}:${m.step}`)) continue;
    g.rows.push(m);
  }
  return out.map(item => {
    if (!item.rows) return item;
    const activities=[], calls=new Map();
    let answer=null;
    for (const m of item.rows) {
      const entries=m.activities ?? [];
      const hasCalls=entries.some(a=>a.kind==='tool');
      if (m.role === 'assistant' && m.content) {
        if (hasCalls) activities.push({kind:'commentary',text:m.content});
        else { if (answer?.content) activities.push({kind:'commentary',text:answer.content}); answer=m; }
      }
      for (const a of entries) {
        if (a.kind === 'tool' && typeof a.callId === 'string') {
          const existing=calls.get(a.callId);
          if (existing) Object.assign(existing,a);
          else { const copy={...a}; calls.set(a.callId,copy); activities.push(copy); }
        } else if (a.kind === 'result') {
          const call=calls.get(a.callId);
          if (call) { call.status=a.status; call.output=a.text; }
          else activities.push({...a});
        } else activities.push({...a});
      }
    }
    const last=item.rows.at(-1) ?? {};
    const duration=Date.parse(item.end)-Date.parse(item.start);
    return {...(answer ?? last),id:`run:${item.key}`,role:'assistant',content:answer?.content ?? '',activities,
      activitySources:item.rows,
      markdownRequested:item.markdownRequested === true,
      runComplete:typeof item.end==='string',streaming:!item.end && item.rows.some(m=>m.streaming),
      ...(Number.isFinite(duration) && duration >= 0 ? {durationMs:duration} : {}),
      createdAt:item.end ?? answer?.createdAt ?? last.createdAt};
  });
}

/** A format badge reflects the user's requested output format, not incidental markup. */
function requestsMarkdown(value) {
  const text = String(value ?? '');
  if (/(?:不要|不用|无需|禁止|别|避免|不使用|do\s+not|don't|without|avoid|no)\s*[^。！？\n]{0,20}\bmarkdown\b/i.test(text)) return false;
  return /(?:用|使用|以|按|采用|给出|提供|输出|返回|生成|写成)[^。！？\n]{0,24}\bmarkdown\b|\bmarkdown\b\s*(?:格式|形式|输出|文本|文档|format|output)|(?:in|as|using|use|only)\s+(?:a\s+)?markdown\b/i.test(text);
}

// Only known display fields are selected from tool arguments. Never serialize an arbitrary object.
export function toolDisplay(activity) {
  let args={};
  try { args=typeof activity.arguments==='string' ? JSON.parse(activity.arguments) : activity.arguments ?? {}; } catch { /* incomplete stream */ }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args={};
  const name=typeof activity.name==='string' ? activity.name : '工具';
  const edit=/editor|edit|write/i.test(name);
  const shell=/pwsh|shell|bash|terminal/i.test(name);
  return {kind:edit ? 'edit' : shell ? 'command' : 'tool', label:edit ? '编辑' : shell ? 'Pwsh' : name,
    detail:typeof args.description==='string' ? args.description : typeof args.path==='string' ? args.path : name,
    command:typeof args.command==='string' ? args.command : '',
    before:typeof args.old_str==='string' ? args.old_str : '',after:typeof args.new_str==='string' ? args.new_str : ''};
}
