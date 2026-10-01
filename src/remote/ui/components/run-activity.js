import { toolDisplay } from '../activity/run-activity.js';
import { renderActivityIcon } from './brand.js';

const disclosureStates = new Map();
function literal(value) {
  return String(value ?? '').slice(0, 60000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[私钥已隐藏]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi,'$1 [已隐藏]')
    .replace(/((?:password|access[_-]?token|phone[_-]?token|api[_-]?key|secret)\s*[=:]\s*["']?)[^\s"',;]+/gi,'$1[已隐藏]');
}

export function renderRunActivity(message, options={}) {
  if (!message.activities?.length) return null;
  const doc=options.doc ?? globalThis.document;
  const details=doc.createElement('details');
  details.className='message-activity';
  const complete=message.runComplete === true;
  const key=message.id;
  let state=disclosureStates.get(key);
  if (!state || (!state.complete && complete)) state={complete,open:!complete};
  disclosureStates.set(key,state);
  if (disclosureStates.size>300) disclosureStates.delete(disclosureStates.keys().next().value);
  details.open=state.open;
  const summary=doc.createElement('summary');
  summary.className='message-activity__summary';
  const label=doc.createElement('span');
  label.className='message-activity__label';
  const seconds=Number.isFinite(message.durationMs) ? Math.floor(message.durationMs/1000) : null;
  label.textContent=complete ? `用时 ${seconds === null ? '—' : seconds>=60 ? `${Math.floor(seconds/60)}分${seconds%60}秒` : `${seconds}秒`}`
    : message.interrupted ? '连接中断 · 已保留操作记录' : '执行中';
  const chevron=doc.createElement('span');
  chevron.className='message-activity__chevron'; chevron.textContent='›'; chevron.setAttribute('aria-hidden','true');
  summary.append(label,chevron);
  details.addEventListener('toggle',()=>{state.open=details.open;state.complete=complete;});
  const list=doc.createElement('div'); list.className='message-activity__list';
  for (const activity of message.activities) {
    const row=doc.createElement('div'); row.className='message-activity__entry';
    const display=activity.kind==='tool' ? toolDisplay(activity) : null;
    row.append(renderActivityIcon(display?.kind ?? activity.kind,{doc}));
    const content=doc.createElement('div'); content.className='message-activity__content';
    const heading=doc.createElement('div'); heading.className='message-activity__heading';
    const title=doc.createElement('span');
    title.textContent=display ? `${display.label} · ${literal(display.detail)}`
      : activity.kind==='reasoning' ? '思考' : activity.kind==='result' ? '工具结果' : '进展';
    heading.append(title);
    if (display) {
      const status=doc.createElement('span'); status.className='message-activity__status';
      status.textContent={preparing:'准备调用',running:'运行中',completed:'已完成',failed:'失败'}[activity.status] ?? '';
      heading.append(status);
    }
    content.append(heading);
    if (activity.text) {
      const text=doc.createElement('div'); text.className='message-activity__text'; text.textContent=literal(activity.text); content.append(text);
    }
    const sections=display ? [['命令',display.command],['原内容',display.before],['新内容',display.after],['输出',activity.output]] : [];
    for (const [name,value] of sections) {
      if (!value) continue;
      const extra=doc.createElement('details'); extra.className='message-activity__tool-detail';
      const caption=doc.createElement('summary'); caption.textContent=name;
      const pre=doc.createElement('pre'); pre.textContent=literal(value); extra.append(caption,pre); content.append(extra);
    }
    row.append(content); list.append(row);
  }
  details.append(summary,list);
  return details;
}
