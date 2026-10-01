import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../../src/remote/ui/api/normalizers.js';
import { StreamAssembler } from '../../src/remote/ui/ws/stream-assembler.js';
import { toMessages } from '../../src/remote/translate/to-messages.mjs';
import { groupRunMessages, toolDisplay } from '../../src/remote/ui/activity/run-activity.js';
import { normalizeDurableFrame } from '../../src/remote/ui/api/normalizers.js';
import * as messageUI from '../../src/remote/ui/components/message.js';
import { createTestDocument } from './r8b-dom.mjs';
import { normalizeEventFrame } from '../../src/remote/ui/ws/event-normalizer.js';
import { projectMessage } from '../../src/remote/http/routes.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { RecoveryController } from '../../src/remote/ui/recovery/recovery-controller.js';

test('null or opaque tool arguments cannot break rendering or expose arbitrary fields',()=>{
  assert.doesNotThrow(()=>toolDisplay({name:'pwsh',arguments:'null'}));
  const displayed=toolDisplay({name:'pwsh',arguments:'{"secret":"private","unknown":"hidden"}'});
  assert.equal(displayed.command,'');assert.equal(displayed.detail,'pwsh');
});

test('completion collapses an open running panel and later explicit expansion persists',()=>{
  const doc=createTestDocument(), m={id:'transition',role:'assistant',activities:[{kind:'reasoning',text:'Check'}]};
  const running=messageUI.renderRunActivity(m,{doc});assert.equal(running.open,true);
  const done=messageUI.renderRunActivity({...m,runComplete:true},{doc});assert.equal(done.open,false);
  done.open=true;done.dispatch('toggle');
  assert.equal(messageUI.renderRunActivity({...m,runComplete:true},{doc}).open,true);
});

test('durable message replaces its completed transient stream and late stream-end cannot restore duplicate',()=>{
  const owner={state:{messages:[{id:'stream:a',role:'assistant',turn:1,step:1}],sessions:[]},
    updateRecovery(value){this.state={...this.state,...value};}};
  const r=new RecoveryController({owner,live:{}});
  r.domainChanged({kind:'domain',frame:{event:'message.created',sessionId:'s',sourceSequence:5,
    data:{dsh_event:'assistant/message',payload:{turn:1,step:1,message:{content:[{type:'text',text:'Done'}]}}}}});
  r.domainChanged({kind:'stream-end',message:{id:'stream:a',role:'assistant',turn:1,step:1}});
  assert.equal(owner.state.messages.length,1);
  assert.equal(owner.state.messages[0].id,'s:5:message');
});

test('preparing typed tool call is assembled separately without leaking JSON into answer',()=>{
  const s=new StreamAssembler();s.start({data:{attempt_id:'tool'}});
  s.delta({data:{attempt_id:'tool',index:1,chunk:{type:'tool-call-delta',index:0,id:'c',name:'pwsh',argumentsDelta:'{"command":'}}});
  s.delta({data:{attempt_id:'tool',index:2,chunk:{type:'tool-call-delta',index:0,id:'c',argumentsDelta:'"Get-Location"}'}}});
  const m=s.active()[0];assert.equal(m.content,'');
  assert.equal(m.activities[0].arguments,'{"command":"Get-Location"}');
  assert.equal(m.activities[0].status,'preparing');
});

test('Gateway timestamp remains the DSH source time for live whole-turn timing',()=>{
  assert.equal(normalizeEventFrame({event:'session.status',timestamp:'2026-10-01T00:00:05Z'}).sourceTime,'2026-10-01T00:00:05Z');
});

test('documented toolCallId matches tool result to call, including failed output',()=>{
  const m=normalizeMessage({id:'t',role:'tool',event_type:'tool/result',content:{ok:false,
    message:{content:[{type:'tool-result',toolCallId:'c',isError:true,content:[{type:'text',text:'Denied'}]}]}}});
  assert.equal(m.activities[0].callId,'c');
  assert.equal(m.activities[0].status,'failed');
  assert.equal(m.activities[0].text,'Denied');
});

test('durable user block container remains readable in a live frame',()=>{
  const m=normalizeDurableFrame({sessionId:'s',sourceSequence:1,data:{dsh_event:'user/message',
    payload:{role:'user',content:[{type:'text',text:'hello'}]}}});
  assert.equal(m.content,'hello');
});

test('correlation metadata survives domain and HTTP projection',async()=>{
  const service=new MessagesService({adapter:{getMessages:async()=>({messages:[{
    id:'s:1',session_id:'s',sequence:1,role:'assistant',type:'message',turn:4,step:2,call_id:'c',
    turn_started_at:'2026-10-01T00:00:00Z',turn_ended_at:'2026-10-01T00:00:05Z'}],throughSeq:1})}});
  const page=await service.list('s');
  const m=projectMessage(page.messages[0]);
  assert.equal(m.turn,4);assert.equal(m.step,2);assert.equal(m.call_id,'c');
  assert.equal(m.turn_ended_at,'2026-10-01T00:00:05Z');
});

test('one turn groups paired tool results and final answer; separate turns stay separate',()=>{
  const rows=[
    {id:'a',role:'assistant',turn:1,step:1,sessionId:'s',content:'Checking',activities:[{kind:'tool',callId:'c',name:'pwsh',arguments:'{}'}]},
    {id:'b',role:'tool',turn:1,step:1,sessionId:'s',activities:[{kind:'tool',callId:'c',status:'running'}]},
    {id:'c',role:'tool',turn:1,step:1,sessionId:'s',activities:[{kind:'result',callId:'c',status:'completed',text:'OK'}]},
    {id:'d',role:'assistant',turn:1,step:2,sessionId:'s',content:'Done',activities:[],turnStartedAt:'2026-10-01T00:00:00Z',turnEndedAt:'2026-10-01T00:00:05Z'},
    {id:'e',role:'assistant',turn:2,step:1,sessionId:'s',content:'Second',activities:[]}
  ];
  const groups=groupRunMessages(rows);
  assert.equal(groups.length,2);
  assert.equal(groups[0].content,'Done');
  assert.equal(groups[0].activities.filter(a=>a.kind==='tool').length,1);
  assert.equal(groups[0].activities.find(a=>a.kind==='tool').output,'OK');
  assert.equal(groups[0].durationMs,5000);
});

test('live durable wrapper has canonical history identity and activity',()=>{
  const m=normalizeDurableFrame({sessionId:'s',sourceSequence:9,sourceTime:'2026-10-01T00:00:00Z',
    data:{dsh_event:'tool/call',payload:{turn:1,step:2,callId:'c',name:'pwsh',arguments:'{}'}}});
  assert.equal(m.id,'s:9:tool_call');
  assert.equal(m.activities[0].callId,'c');
});

test('completed activity is collapsed above the answer, running activity expands, unsafe text stays literal',()=>{
  const doc=createTestDocument();
  const message={id:'ui1',role:'assistant',turn:1,step:1,sessionId:'ui',content:'Done',
    activities:[{kind:'reasoning',text:'<script>alert(1)</script>'}],turnEndedAt:'2026-10-01T00:00:05Z'};
  assert.equal(typeof messageUI.renderRunActivity,'function');
  const panel=messageUI.renderRunActivity({...message,runComplete:true},{doc});
  assert.ok(panel);
  assert.equal(panel.open,false);
  assert.equal(panel.querySelector('script'),null);
  assert.match(panel.textContent, /alert\(1\)/);
  const running=messageUI.renderRunActivity({...message,id:'ui2',runComplete:false,streaming:true},{doc});
  assert.equal(running.open,true);
});

test('DSH disclosed reasoning and calls remain separate from answer prose', () => {
  const m = normalizeMessage({id:'a',role:'assistant',turn:2,step:1,content:{content:[
    {type:'reasoning',text:'Inspect file first'}, {type:'tool-call',id:'c',name:'pwsh',arguments:'{"command":"Get-Location"}'},
    {type:'text',text:'Done'}]}});
  assert.equal(m.content, 'Done');
  assert.equal(m.turn, 2);
  assert.equal(m.activities[0].text, 'Inspect file first');
  assert.equal(m.activities[1].callId, 'c');
});

test('typed stream reasoning is not final prose; block completion and replay do not duplicate text', () => {
  const s = new StreamAssembler();
  s.start({sequence:1,sessionId:'s',sourceTime:'2026-10-01T00:00:00Z',data:{attempt_id:'a',turn:2,step:1}});
  const delta = (index,chunk) => s.delta({sequence:index+2,data:{attempt_id:'a',index,chunk}});
  delta(0,{type:'reasoning-delta',index:0,text:'Inspect'});
  delta(1,{type:'text-delta',index:1,text:'Done'});
  delta(2,{type:'block-end',index:1,block:{type:'text',text:'Done'}});
  delta(2,{type:'block-end',index:1,block:{type:'text',text:'Done'}});
  const m=s.active()[0];
  assert.equal(m.content,'Done');
  assert.equal(m.activities[0].text,'Inspect');
  assert.equal(m.turn,2);
});

test('history preserves whole-turn timing and tool call identity', () => {
  const events=[
    {type:'turn/start',seq:1,time:1000,data:{turn:2}},
    {type:'tool/call',seq:2,time:2000,data:{turn:2,step:1,callId:'c',name:'pwsh',arguments:'{}'}},
    {type:'assistant/message',seq:3,time:4000,data:{turn:2,step:2,message:{content:[{type:'text',text:'Done'}]}}},
    {type:'turn/end',seq:4,time:5000,data:{turn:2,reason:'completed'}}
  ];
  const messages=toMessages(events.map(event=>({type:'event',event})),'s');
  assert.equal(messages[1].call_id,'c');
  assert.equal(messages[2].turn,2);
  assert.equal(messages[2].turn_started_at,new Date(1000).toISOString());
  assert.equal(messages[2].turn_ended_at,new Date(5000).toISOString());
});
