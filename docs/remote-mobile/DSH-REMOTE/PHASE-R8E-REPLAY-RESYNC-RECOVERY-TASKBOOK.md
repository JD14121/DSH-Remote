# Phase R8E — Replay, Resync & Interrupted-Stream Recovery

## 0. Phase identity

```text
Project:
D:\DSH-testing\dsh-remote-gateway

Phase:
R8E — Replay, Resync & Interrupted-Stream Recovery

Parent:
R8 — Mobile Chat UI & Loopback Acceptance

Prerequisites:
R8B ACCEPTED
R8C ACCEPTED
R8C.1 ACCEPTED
R8D ACCEPTED

R7:
CONDITIONALLY ACCEPTED FOR R8 DEVELOPMENT
R7-KNOWN-LIMITATION-01 RETAINED

R9:
NOT STARTED
```

R8E 的唯一目标：

```text
socket disconnect
      ↓
reconnect + replay
      ↓
if replay sufficient:
    resume live without duplication

if replay impossible / sequence gap:
    enter resync_required
      ↓
REST reload authoritative history
      ↓
reset local event state
      ↓
obtain fresh WS ticket
      ↓
new socket
      ↓
replay boundary
      ↓
live
```

R8E 不修改 Gateway replay/journal protocol。

---

# 1. Hard scope

允许：

```text
normal reconnect replay completion
sequence-gap recovery
resync_required UX
REST reload
local timeline replacement
last_sequence reseeding
interrupted-stream reconciliation
fresh WS ticket
socket recreation
recovery state tests
```

禁止：

```text
new WS frame types
new journal semantics
new retention semantics
new Gateway replay API
DSH lifecycle changes
SSH
Tailscale
LAN binding
TLS
session-create route
```

---

# 2. Existing protocol remains authoritative

R4/R5/R6 已冻结：

```text
WS /api/v1/events

hello
replay
replay_complete
live events

resync-required conditions

durable journal authority
Gateway sequence
one-time WS ticket
```

R8E 只能消费这些语义。

如果现有协议无法区分：

```text
recoverable replay
vs
must-resync
```

则：

```text
R8E BLOCKED — PROTOCOL GAP
```

不得自行扩展 Gateway frame。

---

# 3. Two recovery paths

必须严格区分：

## Path A — normal replay

```text
disconnect
→ reconnecting
→ fresh ticket
→ WS with last_sequence
→ hello
→ replay events
→ replay_complete
→ connected
```

不需要 REST reload。

## Path B — resync

```text
replay unavailable / sequence gap / server resync_required
→ resync_required
→ stop applying live frames
→ user activates Reload conversation
→ GET messages
→ rebuild authoritative local timeline
→ reseed sequence
→ fresh ticket
→ new WS
→ replay_complete
→ connected
```

不得把两条路径混成一个“永远 reload”。

---

# 4. Recovery controller

新增集中式：

```text
src/remote/ui/recovery/
  recovery-controller.js
  resync-controller.js
  timeline-reconciler.js
```

或同等结构。

Component 中禁止直接执行：

```text
ApiClient.getMessages()
TicketClient.issue()
EventClient.connect()
```

恢复流程必须由 controller ownership 管理。

---

# 5. Recovery generation

每次 recovery attempt 分配：

```text
recoveryGeneration
```

异步步骤必须校验 generation。

例如：

```text
resync A begins
→ user switches session
→ A's REST response arrives late
```

必须：

```text
ignore A
```

不得覆盖新 session。

---

# 6. `resync_required` authority

进入 resync 可以来自：

```text
server explicit resync_required
client sequence gap detection
replay retention miss / too-old sequence
```

一旦进入：

```text
connectionState = resync_required
```

普通 live frame application 必须停止或隔离。

不得继续：

```text
apply future seqs
and hope missing event does not matter
```

---

# 7. Resync UI contract

显示已冻结：

```text
Conversation changed while you were offline.

[ Reload conversation ]
```

必须有四个 substate：

```text
ready_to_reload
loading
reconnected
reload_failed
```

不要新增第七 connection state。

这些是：

```text
resync UI substate
```

---

# 8. User-triggered reload

遵循现有 UX：

```text
resync_required
→ operator presses Reload conversation
```

不要自动立刻清空 timeline。

点击后：

```text
preserve current timeline visibly
mark loading
```

直到 REST history 成功。

这样失败时仍可看到旧内容。

---

# 9. Authoritative REST reload

调用：

```text
GET /api/v1/sessions/:id
GET /api/v1/sessions/:id/messages
```

按现有 R8C ApiClient。

不得：

```text
直接调用 DSH
从 WS journal 自己重建完整历史
```

REST history 是 resync reset 的 authoritative browser view。

---

# 10. Atomic timeline replacement

REST reload 成功后：

```text
build replacement state off-screen / in memory
validate session identity
validate request generation
then atomically replace timeline
```

不要：

```text
clear timeline
→ fetch
→ fail
→ blank page
```

---

# 11. Draft preservation

Resync 必须保留：

```text
composer draft
selected but not yet sent text
local attachment selections where safe
scroll intention where practical
```

不得因为 history reload：

```text
clear draft
re-open credential dialog
```

---

# 12. Server-derived messages win

REST reload 后：

```text
server history
```

是 message history authority。

Browser optimistic item 只有在可以安全匹配时才保留/merge。

如果无法证明是同一 logical message：

```text
prefer authoritative server history
```

不要制造 duplicate。

---

# 13. requestId reconciliation

R8C send 使用 stable `requestId`。

如果 REST history / event contract 暴露对应 identity：

用它去匹配：

```text
optimistic UserMessage
↔ durable server message
```

如果不暴露：

不得猜。

记录现有 identity capability。

必要时：

```text
R8E_MESSAGE_IDENTITY_LIMITATION
```

但不要直接修改 backend contract。

---

# 14. Interrupted assistant stream

关键场景：

```text
assistant.start
chunk A
chunk B
disconnect
```

本地已有：

```text
partial = AB
interrupted = true
```

### Normal replay

如果 replay 补：

```text
chunk B duplicate
chunk C
end
```

结果必须：

```text
ABC
```

### Full resync

如果 replay 无法恢复：

```text
REST reload
```

则 REST authoritative history 决定最终 message。

本地 interrupted transient：

```text
must not coexist as duplicate
```

---

# 15. Stream reconciliation rules

至少覆盖：

```text
partial transient exists
+ REST final assistant message exists
→ replace/resolve transient

partial transient exists
+ REST has no final corresponding message
→ do not silently mark completed
```

若 identity 不足以证明匹配：

保守策略：

```text
remove transient only when authoritative reload clearly supersedes timeline
```

并记录原因。

---

# 16. Sequence reseed

Full REST reload 完成后：

必须重新确定：

```text
lastAppliedSequence
```

来源只能是已有 server-derived state。

允许：

```text
session view last_sequence
authoritative REST metadata
```

禁止：

```text
old gap received value
Date.now()
number of messages
local counter
```

---

# 17. Clear gap state

只有 REST reload 成功并重新 seed 后：

```text
clear:
  gap
  expected
  received
  resync-blocked state
```

失败则保留：

```text
resync_required
```

---

# 18. Fresh ticket after resync

REST reload 后：

```text
POST /api/v1/auth/ws-ticket
```

必须获取新 ticket。

禁止复用：

```text
ticket from failed socket
ticket from pre-resync reconnect
```

---

# 19. New EventClient generation

Resync reconnect：

```text
old EventClient closed
old generation invalidated
new ticket
new EventClient generation
```

任何 late frame：

```text
old socket
old replay
old close callback
```

不得影响新 timeline。

---

# 20. Handshake after resync

连接：

```text
WS(... last_sequence=<new seed>)
```

然后：

```text
hello
replay
replay_complete
```

只有：

```text
replay_complete
```

之后：

```text
connectionState = connected
```

---

# 21. No duplicate history during replay

REST 已经加载到 sequence N。

随后 WS replay 可能包含：

```text
<= N
```

必须全部 dedupe。

不得在刚 reload 后：

```text
REST message
+
same replayed durable event
```

重复一次。

---

# 22. Replay from snapshot boundary

测试：

```text
REST snapshot last_sequence = 40

WS replay:
38
39
40
41
42
replay_complete
```

结果：

```text
38–40 ignored
41–42 applied
lastAppliedSequence = 42
```

---

# 23. Replay gap after resync

如果刚完成 REST reload：

```text
seed = 40
```

但 WS 第一 durable event：

```text
45
```

仍然必须再次：

```text
resync_required
```

不得因为“刚 resync 过”就忽略 gap。

---

# 24. Repeated resync

必须支持：

```text
resync
→ recovery
→ later another retention gap
→ resync again
```

controller 不能是一次性对象。

但不能：

```text
同时运行两个 resync
```

---

# 25. Double-click protection

用户快速点击：

```text
Reload conversation
Reload conversation
```

必须 single-flight。

只允许：

```text
one REST reload chain
one new ticket
one reconnect
```

---

# 26. Session switch during resync

场景：

```text
Session A resync loading
→ user selects Session B
```

必须：

```text
abort A REST where possible
invalidate A recovery generation
close A socket/reconnect state
load B normally
```

A 的 late callback 全部忽略。

---

# 27. Auth failure during resync

如果：

```text
GET messages → 401
```

则：

```text
clear Phone credential
connectionState = auth_required
```

不要继续申请 WS ticket。

---

# 28. Gateway unavailable during resync

如果：

```text
GET messages network failure
```

则：

```text
credential preserved
connectionState remains appropriate unavailable/recovery state
timeline preserved
retry action available
```

不要退回 auth。

---

# 29. REST 404 session disappeared

如果：

```text
GET session/messages → 404
```

必须定义清晰行为。

建议：

```text
selected session marked unavailable
refresh session list
do not keep reconnecting a nonexistent session
```

如果现有 contract 没有明确 error mapping：

记录并测试当前 Gateway semantics。

---

# 30. Resync retry

`reload_failed`：

```text
same Reload conversation action remains available
```

第二次 retry：

```text
fresh REST request
fresh ticket only after success
```

不得 reuse partially completed recovery state。

---

# 31. Scroll behavior

Normal replay：

```text
preserve scroll position
```

除非用户原本就在底部，则继续 auto-stick。

Full reload：

尽量：

```text
restore by message anchor
```

若实现成本过高，可退化：

```text
restore near previous message / latest
```

但不得强制跳到顶部。

---

# 32. Queue state reconciliation

REST reload + replay 后：

```text
queue depth
running/waiting status
```

必须收敛到 server authority。

不要长期保留：

```text
optimistic queued state
```

如果 server snapshot 已不支持它。

---

# 33. Cancel reconciliation

如果：

```text
cancel POST succeeded
disconnect before cancelled event
```

然后 resync：

REST/replay 最终状态为 authority。

不得凭 cancel POST 结果永久强制：

```text
cancelled
```

---

# 34. Upload state

本地上传已经成功并拿到 server response：

可以保留。

纯 browser-local 尚未上传选择：

在 resync 中保留。

失败 upload：

不要因为 timeline resync 自动 retry。

---

# 35. Resync loop protection

如果：

```text
reload succeeds
→ connect
→ immediate resync_required
→ reload
→ immediate resync_required
...
```

必须 bounded。

例如：

```text
max automatic reconnect/resync transitions
```

超过后保持：

```text
resync_required / reload_failed
```

等待人工动作。

禁止 infinite request loop。

---

# 36. Server explicit resync reason

如果 frame/close contract 包含 safe reason code：

内部可以记录：

```text
too_old
retention_gap
server_requested
sequence_gap
```

UI 不需要显示内部码。

禁止显示 raw close reason。

---

# 37. R5 durable semantics are untouchable

R8E 不修改：

```text
journal
snapshot
retention
sequence allocator
recovery reconciliation
```

浏览器只是：

```text
consumer
```

如果 browser 需要的 replay 无法由 R5/R4 contract满足：

```text
STOP — PROTOCOL GAP
```

---

# 38. Session-retention semantic decision

记录人工决策：

```text
R8-SESSION-RETENTION-SEMANTIC-NOTE

R8 decision:
OPTION A — KEEP UNION
```

即：

```text
GET /sessions
=
current DSH enumeration
UNION
Gateway tracked history
```

R8E 不修改这一行为。

更新 UX 文档，避免继续声称严格等于 current adapter set。

Future：

```text
explicit deletion semantics
```

另开 backend phase。

---

# 39. Fixture mode

继续保证：

```text
#fixture=...
→ 0 REST
→ 0 WS
→ 0 ticket
```

R8E recovery fixtures 可以纯本地模拟：

```text
gap
resync loading
resync failed
resync success
```

但不得误触 real network。

---

# 40. CSP

保持：

```text
connect-src 'self'
```

不得扩展。

---

# 41. Security

REST history、WS replay、live frames 全部视为：

```text
untrusted data
```

继续通过 safe renderer。

特别测试 resync history 中包含：

```text
<script>
<img onerror>
javascript:
```

不能执行。

---

# 42. Secret hygiene

不得记录：

```text
Phone token
WS ticket
Authorization header
raw ticket URL
dsh-auth
launch token
```

Recovery evidence 中只允许：

```text
request outcome
sequence numbers
session ids if non-secret
error code
```

---

# 43. Tests

至少增加：

```text
r8e-recovery-controller.test.mjs
r8e-resync.test.mjs
r8e-replay-reconciliation.test.mjs
r8e-stream-reconciliation.test.mjs
r8e-session-switch.test.mjs
r8e-recovery-errors.test.mjs
r8e-security.test.mjs
r8e-integration.test.mjs
```

---

# 44. Mandatory scenarios

覆盖：

```text
normal reconnect without REST reload

explicit server resync_required

client sequence gap → resync

REST reload success

REST reload failure

401 during reload

network failure during reload

404 selected session

double Reload click

session switch during reload

old socket late frame

old REST late response

fresh ticket after reload

dedupe replay <= seed

apply replay > seed

second gap after resync

interrupted stream → normal replay

interrupted stream → full REST reload

cancel then disconnect then resync

draft preservation

attachment preservation

hostile content safety
```

---

# 45. Integration test

使用：

```text
real ApiClient
real EventClient
real recovery controller
real DOM/component tree
controlled HTTP + WS fixture
```

必须实际走：

```text
connected
→ stream partial
→ socket loss
→ reconnect
→ resync_required
→ REST messages
→ new ticket
→ new WebSocket
→ replay_complete
→ connected
```

最终验证：

```text
no duplicate message
draft preserved
partial/final content coherent
one current socket
correct sequence watermark
```

---

# 46. Live production smoke

仍不自动启动 R7 Supervisor。

如果安全运行中的真实 Gateway 存在：

可执行 read-only：

```text
session list
message history
ticket
WS connect
disconnect/reconnect
```

不要产生模型 prompt。

否则：

```text
live_resync_smoke = deferred_to_R8G
```

---

# 47. UI polish backlog

继续保留：

```text
R8-UI-POLISH-BACKLOG-01
```

R8E 只允许 recovery 所需的小型视觉调整：

```text
loading state
retry state
reconnected confirmation
```

不做整体美化。

---

# 48. Runtime protection

禁止修改：

```text
DshAdapter
R4 WS protocol
R5 journal/snapshot
R6 ticket semantics
Supervisor
DshProcess
Phone credential format
```

若必须改：

```text
R8E BLOCKED — PROTOCOL GAP
```

---

# 49. Regression

运行：

```text
npm run test:r8e
npm run test:r8d
npm run test:r8c1
npm run test:r8c
npm test
npm run compliance:r5a
```

要求：

```text
0 new failures
R5A PASS
encoding clean
forbidden cmdlets 0
```

---

# 50. Evidence

生成：

```text
docs/remote-mobile/_evidence/r8e-recovery.json
```

至少：

```json
{
  "phase": "R8E",
  "normal_replay_without_reload": true,
  "sequence_gap_enters_resync": true,
  "rest_reload_atomic": true,
  "draft_preserved": true,
  "old_generation_ignored": true,
  "fresh_ticket_after_resync": true,
  "replay_dedup_after_reload": true,
  "interrupted_stream_reconciled": true,
  "double_reload_single_flight": true,
  "resync_loop_bounded": true,
  "unsafe_html_sinks": 0,
  "session_retention_decision": "A_keep_union",
  "live_resync_smoke": "deferred_to_R8G",
  "r8f_started": false,
  "r9_started": false
}
```

填实际值。

---

# 51. Required report

生成：

```text
PHASE-R8E-REPORT.md
```

回答：

```text
Is normal replay handled without REST reload?

What exactly triggers full resync?

Can frames continue applying after a gap?

Is REST reload atomic?

Is the existing timeline retained if reload fails?

Are drafts preserved?

Are local attachments preserved?

How is last_sequence reseeded?

Can replay duplicate REST-loaded messages?

Can interrupted streaming duplicate a final message?

Does resync use a fresh WS ticket?

Can an old socket affect the new connection?

Can an old REST response overwrite a new session?

Are repeated Reload clicks single-flight?

Can resync loop forever?

How are 401, network failure and 404 distinguished?

Was R4/R5/R6 protocol modified?

Was session-retention semantic changed?

Expected:
NO — Option A retained.

Was R8F started?

Was R9 started?
```

---

# 52. Definition of Done

PASS requires：

```text
normal replay path complete

full resync path complete

atomic REST history reload

sequence reseed safe

replay dedup safe

interrupted stream reconciliation safe

draft/attachment preservation

fresh ticket after resync

generation race protection

single-flight reload

bounded recovery loops

error classifications correct

safe rendering retained

session union semantic documented

no protocol changes

R8E tests green

full regression green

R5A PASS

R8F not started

R9 not started
```

---

# 53. Stop gate

成功：

```text
R8E COMPLETE — STOPPING HERE.
```

协议缺口：

```text
R8E BLOCKED — PROTOCOL GAP — STOPPING HERE.
```

失败：

```text
R8E FAILED — STOPPING HERE.
```

无论结果：

```text
DO NOT START R8F
UNTIL HUMAN ACCEPTANCE

NO R9
NO SSH
NO TAILSCALE
NO FIREWALL CHANGE
NO LAN BIND
NO TLS
```