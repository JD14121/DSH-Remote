# Phase R2 — Session / Message / Event Domain Model

> 前置阶段：Phase R1 — DSH Adapter Boundary & Contract Tests
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段目标：在已经稳定的 `DshAdapter` 之上建立手机 Remote Gateway 所需的 **Session / Message / Event 领域模型、九状态状态机、Gateway-owned 单调事件序列、内存态会话视图**。
>
> **R2 不实现网络 Server，不实现磁盘持久化，不实现手机鉴权，不实现 Supervisor，不实现 SSH/Tailscale，不实现正式 UI。**
>
> 完成 R2 后必须生成 `PHASE-R2-REPORT.md` 并停止，不得自动进入 R3。

---

# 0. R1 验收结论

R1 已验收通过，以下事实视为 R2 基线：

```text
Project:
D:\DSH-testing\dsh-remote-gateway

DSH:
@deepseek-ai/dsh@0.1.5-rc.2

Substrate:
POST /api/<namespace>/<method>
WS   /api/remote.mux

R1 tests:
82 pass / 0 fail
```

已稳定的 Adapter：

```js
listSessions()
getSession(id)
getMessages(id, options)
sendMessage(sessionId, message)
subscribe(sessionId, listener)
cancel(sessionId)
```

R1 已证明：

- `client_message_id` 原样映射为 DSH `requestId`。
- `follow` frame ordering 保持。
- opaque assistant chunk 不解析、不重排。
- cancel 映射为真实 `session.cancel`。
- cold cancel → `SESSION_COLD`。
- history 使用 `session/page`。
- DSH wire 只存在于 Adapter/Wire 层。
- DSH version mismatch fail closed。
- 现有项目无修改。
- 13/13 protected hashes unchanged。
- 原有 regression baseline 无新增失败。

---

# 1. R2 的范围纠正

R1 报告 §20 写到：

```text
Persist sessions, messages and a Gateway-owned monotonic sequence
```

但原阶段划分同时明确：

```text
R5 = Persistence + replay
```

因此 R2 按以下解释执行：

```text
R2:
  domain model
  state machine
  in-memory stores
  in-memory monotonic sequence allocator
  deterministic transition rules
  normalization
  snapshot/reseed interfaces

R5:
  JSONL / disk persistence
  startup recovery
  durable sequence
  replay after restart
```

**R2 禁止创建真正的磁盘持久化实现。**

不得创建：

```text
src/remote/persistence.mjs
$DSH_HOME\remote\events\
$DSH_HOME\remote\state\
*.jsonl event log
```

除非仅在 tests 的临时目录中作为 fixture 数据，不得作为产品实现。

---

# 2. R2 Architecture

目标：

```text
DSH
 │
 ▼
DshAdapter                 ← R1
 │
 ├── session/list
 ├── session/page
 ├── session/follow
 ├── session/control
 └── session events
 │
 ▼
R2 Domain Layer
 │
 ├── Session model
 ├── Message model
 ├── Gateway Event model
 ├── Status state machine
 ├── In-memory sequence allocator
 └── In-memory session view
 │
 ▼
future R3 REST / R4 WS
```

R3/R4 以后只能消费 R2 的 domain objects。

不得让 future server 直接理解：

```text
SessionWireEvent
SessionFollowFrame
SessionControlFrame
Typert
DSH endpoint names
```

---

# 3. 建议文件结构

创建或扩展：

```text
src/remote/
  sessions.mjs
  messages.mjs
  events.mjs

  model/
    session.mjs
    message.mjs
    event.mjs
    status.mjs
    sequence.mjs
    signals.mjs

  state/
    session-state-machine.mjs
    session-view-store.mjs

tests/remote/
  model-session.test.mjs
  model-message.test.mjs
  model-event.test.mjs
  status-machine.test.mjs
  sequence.test.mjs
  session-view-store.test.mjs
  domain-integration.test.mjs
```

如果现有代码结构更适合其它命名，可调整，但必须保持：

```text
model
state
adapter
wire
```

职责分离。

---

# 4. Session Domain Model

创建：

```text
src/remote/model/session.mjs
```

统一输出：

```js
{
  id,
  title,
  status,
  created_at,
  updated_at,
  workspace_id?,
  cwd?,
  last_sequence,
  running,
  metadata?
}
```

要求：

- `id` 必须来自真实 DSH session id。
- 不生成第二套 conversation id。
- `status` 必须来自 R2 状态机。
- `last_sequence` 是 Gateway event sequence，不是 DSH session cursor。
- `created_at` / `title` 若无证据不得编造。
- raw DSH fields 如需保留，放在明确的 `metadata` 中。
- 手机 REST 层以后不得依赖 `metadata` 才能正常工作。

---

# 5. Title / created_at Source Audit

R1 当前：

```text
title = null
created_at = null
```

R2 必须先只读检查：

```text
SessionWireHeader
follow snapshot
session/page header
projection baseline
workspace registry
session title projection / title event
```

确定：

```text
title
created_at
updated_at
```

的真实来源。

优先原则：

```text
public/adapter-visible DSH data
    >
projection/cache exposed through Adapter
    >
read-only workspace registry
    >
null
```

禁止：

- 根据首条 prompt 猜 title。
- 用文件 mtime 伪造 created_at。
- 直接解析 zstd session log。
- 修改 `.dsh`。
- 访问 `.credentials.yaml`。

如果某字段无法可靠取得：

```text
保持 null
```

并在 `PHASE-R2-REPORT.md` 明确记录。

---

# 6. Message Domain Model

创建：

```text
src/remote/model/message.mjs
```

目标 schema：

```js
{
  id,
  session_id,
  role,
  type,
  content,
  created_at,
  sequence,
  source_sequence?,
  metadata?
}
```

允许 role：

```text
user
assistant
system
tool
```

允许 type 至少：

```text
message
tool_call
tool_result
reasoning
unknown
```

不要为了满足 UI 强行把所有 DSH event 都塞成 `"message"`。

---

## 6.1 Message ID

必须稳定、可重复计算。

推荐：

```text
session-id + DSH durable sequence + normalized type
```

或 deterministic hash。

要求：

- 同一 durable event 多次读取得到相同 message id。
- 不使用随机 UUID 给历史消息重新编号。
- assistant streaming delta 与最终 durable assistant message 必须可区分。
- 不使用 Gateway event sequence 作为唯一 message id。

---

## 6.2 Unknown Event

继续遵守 R1：

```text
unknown != dropped
```

任何新/未知 DSH event：

必须：

```text
fail-visible
```

保留：

```text
type = unknown
source sequence
safe payload
```

不得 silent discard。

---

# 7. Gateway Event Model

创建：

```text
src/remote/model/event.mjs
```

Gateway event 是手机 realtime API 未来唯一看到的实时事件结构。

建议：

```js
{
  sequence,
  event,
  session_id,
  timestamp,
  data
}
```

`sequence`：

```text
Gateway-owned
monotonic
per session
integer
```

推荐 event vocabulary：

```text
session.status
message.created
assistant.start
assistant.delta
assistant.end
tool.started
tool.output
tool.completed
task.progress
task.completed
task.failed
task.cancelled
transport.disconnected
transport.reconnected
unknown
```

如 R2 audit 证明现有 DSH 信号不足以支持某个事件：

保留 vocabulary，但不得伪造事件。

---

# 8. DSH Sequence vs Gateway Sequence

必须严格区分：

```text
DSH durable seq / cursor
```

与：

```text
Gateway event sequence
```

两者不得混用。

示例：

```text
DSH event seq = 418
Gateway event sequence = 92
```

完全合法。

原因：

一个 DSH durable event 可能产生多个 Gateway events：

```text
assistant stream start
assistant delta
assistant delta
assistant end
message.created
session.status
```

而 stream chunk 未必有 DSH durable event seq。

---

# 9. Monotonic Sequence Allocator

创建：

```text
src/remote/model/sequence.mjs
```

或等价模块。

R2 仅做：

```text
in-memory
```

API 建议：

```js
next(sessionId)
peek(sessionId)
seed(sessionId, lastSequence)
reset(sessionId)
```

要求：

```text
first emitted sequence > seed
strictly monotonic
never duplicate
per-session isolation
safe under concurrent calls
integer only
```

必须测试：

- 1000 连续分配无重复。
- 两 session 相互独立。
- seed 100 → next = 101。
- concurrent emission 不重复。
- invalid seed fail closed。

---

# 10. Future R5 Compatibility

虽然 R2 不写磁盘，但 sequence allocator 必须支持：

```js
seed(sessionId, persistedLastSequence)
```

这样 R5 可以：

```text
load state
↓
seed()
↓
continue sequence
```

不得设计成：

```text
process start always sequence = 1
```

且未来无法恢复。

---

# 11. Status Vocabulary

创建：

```text
src/remote/model/status.mjs
```

唯一合法状态：

```text
idle
queued
running
waiting_input
completed
failed
cancelled
disconnected
```

注意：原任务书写了九状态，但实际列举的是以上 **8 个唯一值**。

R2 必须：

1. 以实际唯一枚举为准。
2. 在报告中明确记录“文案称九状态、枚举实际为 8”这一规格不一致。
3. 不擅自创造第 9 个状态。

除非 R0/R1 源文档存在另一个明确第 9 状态证据，否则：

```text
STATUS_COUNT = 8
```

---

# 12. State Machine

创建：

```text
src/remote/state/session-state-machine.mjs
```

状态机输入必须是 **normalized domain signals**，而不是散落的 raw DSH event 名。

创建：

```text
src/remote/model/signals.mjs
```

建议 signal vocabulary：

```text
SESSION_DISCOVERED
PROMPT_ACCEPTED_QUEUE
PROMPT_ACCEPTED_STEER
RUN_STARTED
RUN_COMMITTED
RUN_ABANDONED
QUEUE_EMPTY
WAITING_FOR_USER
TASK_FAILED
CANCEL_ACCEPTED
TRANSPORT_LOST
TRANSPORT_RESTORED
SESSION_COLD
```

最终具体信号名称可调整，但必须：

- centralize。
- test。
- 不让 raw DSH wire 名进入状态机。

---

# 13. Evidence-based Status Derivation

禁止“看起来合理”的状态推断。

每个 transition 必须有：

```text
source signal
source evidence
previous state
next state
```

例如：

```text
PROMPT_ACCEPTED_QUEUE:
idle/waiting_input → queued

RUN_STARTED:
queued/idle/waiting_input → running

TRANSPORT_LOST:
* → disconnected
```

但对于：

```text
completed
waiting_input
failed
cancelled
```

必须先证明 DSH 有足够信号。

如果实际 wire 无法可靠区分：

```text
assistant end committed
```

到底应该是：

```text
completed
```

还是：

```text
waiting_input
```

则不得凭 UI 直觉决定。

先做 evidence audit。

---

# 14. Status Audit

R2 在编码状态机前必须读取当前安装 DSH 的：

```text
session/control types
session follow event types
forwarded API remote events allowlist
agent/session lifecycle events
cancel event behaviour
assistant committed/abandoned semantics
queue mutation semantics
```

生成：

```text
docs/r2-status-evidence.md
```

至少列：

| Raw signal | Meaning | Can derive status? | Confidence |
| --- | --- | --- | --- |

只有：

```text
SUPPORTED
```

的映射才能用于 production state transition。

不确定的写：

```text
UNRESOLVED
```

---

# 15. Disconnected Semantics

`disconnected` 是 **Gateway 对 DSH transport 的观察状态**。

不能把：

```text
手机断网
```

直接等价成：

```text
DSH session disconnected
```

R2 定义：

```text
transport to DSH unavailable
→ disconnected
```

未来手机自己和 Gateway 的断开属于 R4/R5 client connection state，不改变真实 DSH session state。

---

# 16. Cancel Semantics

R1 已确认：

```text
session.cancel
```

返回：

```text
accepted
```

不代表：

```text
Agent 已完全静止
```

并且：

```text
queued inbox may survive
```

因此：

```text
CANCEL_ACCEPTED
```

不能立即无条件把状态永久设置为：

```text
cancelled
```

R2 必须依据后续 DSH follow/control evidence确认终态。

允许：

```text
cancelled
```

作为已观察到 cancel completion / abandoned run 后的状态。

如果 DSH 没有可靠完成证据：

在报告中说明限制。

---

# 17. Session View Store

创建：

```text
src/remote/state/session-view-store.mjs
```

R2 只允许内存实现。

职责：

```text
session summary
current status
latest gateway sequence
known DSH cursor
last update timestamp
optional active run metadata
```

API 示例：

```js
get(sessionId)
upsertSession(session)
applySignal(sessionId, signal)
applyGatewayEvent(event)
list()
snapshot()
restore(snapshot)
```

`restore(snapshot)`：

只是内存接口测试。

不得从磁盘读。

它为 R5 做准备。

---

# 18. Session Service

创建：

```text
src/remote/sessions.mjs
```

职责：

- 从 `DshAdapter.listSessions()` 初始化 session views。
- 获取单 session。
- 将 Adapter summary 转为 domain session。
- 通过 state machine 维护状态。
- 不知道任何 DSH endpoint。
- 不直接调用 `rpcClient`。
- 不访问 `wire/*`。

---

# 19. Messages Service

创建：

```text
src/remote/messages.mjs
```

职责：

```text
adapter.getMessages()
    ↓
domain Message[]
```

要求：

- deterministic IDs。
- stable ordering。
- role/type normalization。
- no silent drop。
- no zstd read。
- pagination metadata 保留。
- DSH source seq 与 Gateway event seq 区分。

---

# 20. Events Service

创建：

```text
src/remote/events.mjs
```

职责：

```text
adapter.subscribe()
     +
optional session/control adapter capability
     ↓
normalized signals
     ↓
state machine
     ↓
Gateway Events
     ↓
sequence allocator
```

R2 的 `events.mjs`：

```text
只负责内存事件生成
```

不负责：

```text
WebSocket server
disk JSONL
replay
network heartbeat
```

这些分别属于：

```text
R4 / R5
```

---

# 21. session/control 接入规则

R1 已声明：

```text
session/control
```

route 存在，但尚未公开为 Adapter method。

如果 R2 的状态模型确实需要 control stream：

允许扩展 Adapter，例如：

```js
subscribeControl(listener, options)
```

或：

```js
subscribeStatus(listener, options)
```

要求：

- 仍由 `DshAdapter` 封装。
- wire endpoint 仍只在 `wire/`。
- R1 六个 method 继续保持兼容。
- 新 capability 必须有 contract tests。
- 不允许 `sessions.mjs` 直接 import `dsh-rpc-client.mjs`。

---

# 22. Adapter Backward Compatibility

R2 可以修改 R1 project files，但必须：

```text
R1 82 tests remain green
```

不得破坏：

```text
listSessions
getSession
getMessages
sendMessage
subscribe
cancel
```

existing signatures。

如果必须扩展返回结构：

必须向后兼容。

---

# 23. In-Memory Reconnect Semantics

R2 可以建模：

```text
DSH transport lost
DSH transport restored
new follow snapshot arrives
```

但不得实现：

```text
last_sequence replay API
disk gap fill
client replay
```

R2 只需证明：

```text
state can be re-seeded
sequence can continue after seed
fresh DSH snapshot can reconcile current in-memory view
```

真正 durable replay：

```text
R5
```

---

# 24. Timestamp Rules

时间统一：

```text
ISO 8601
```

内部可保存：

```text
epoch milliseconds
```

但 public domain objects 输出 ISO。

禁止：

- 用 `Date.now()` 伪装原消息时间。
- 将 receive time 当作 created_at 而不标注。

区分：

```text
source timestamp
gateway observed timestamp
```

必要时：

```js
{
  created_at: sourceTime ?? null,
  observed_at: gatewayTime
}
```

---

# 25. Updated-at Semantics

如果 DSH 没有明确 session `updatedAt`：

允许使用：

```text
latest known source event timestamp
```

但字段必须有明确文档：

```text
derived
```

不得伪称 DSH 原生字段。

---

# 26. R2 Tests

至少创建：

```text
model-session.test.mjs
model-message.test.mjs
model-event.test.mjs
status-machine.test.mjs
sequence.test.mjs
session-view-store.test.mjs
domain-integration.test.mjs
```

---

## 26.1 Status Tests

覆盖：

```text
initial state
prompt queue
prompt steer
run start
run complete
run abandoned
cancel request
cancel observed completion
failure
transport lost
transport restore
invalid transition
duplicate signal
out-of-order signal
```

如果某 raw DSH mapping 无真实证据：

test normalized signal，不要伪造 production raw mapping。

---

## 26.2 Sequence Tests

覆盖：

```text
strict monotonicity
seed
per-session isolation
concurrency
invalid seed
no duplicate
large sequence
snapshot / restore
```

---

## 26.3 Message Tests

覆盖：

```text
stable deterministic ID
stable ordering
user
assistant
system
tool_call
tool_result
unknown
non-JSON opaque content
missing timestamp
source seq preserved
```

---

## 26.4 Event Tests

覆盖：

```text
assistant start
assistant delta
assistant end
message.created
status event
unknown event
gateway sequence assignment
DSH source sequence retained separately
```

---

## 26.5 Integration Test

模拟：

```text
list session
↓
open follow snapshot
↓
send prompt(queue)
↓
queued
↓
assistant start
↓
running
↓
assistant chunks
↓
assistant committed
↓
final domain state
```

验证：

- message IDs 稳定。
- event sequence 严格递增。
- status transition 合法。
- assistant chunk 未被解析。
- DSH seq 未被当成 Gateway sequence。

---

# 27. No Premature Persistence

测试可以：

```text
snapshot()
restore(snapshot)
```

但产品代码不得：

```text
fs.writeFile
fs.appendFile
createWriteStream
JSONL
SQLite
LevelDB
```

用于 domain persistence。

如 R2 新代码必须使用 `fs`：

报告必须逐项解释为何不是持久化。

---

# 28. No Network Listener

R2 不得新增：

```text
http.createServer
https.createServer
net.createServer
WebSocketServer
.listen(
```

已有 R1 出站 WebSocket client 不受此限制。

R2 report 必须 grep 验证：

```text
no inbound listener
```

---

# 29. Security

继续继承 R1：

- 不读取 `.credentials.yaml`。
- 不保存真实 token/cookie。
- 不输出 full env。
- 不把 token 放入 fixture。
- error path 必须 redaction。
- DSH credential 与 future phone Bearer 继续分离。

R2 model/event objects 不允许携带：

```text
cookie
Authorization
launch token
API key
credentials
```

新增测试：

```text
domain event serialization contains no secret-like fields
```

---

# 30. Existing Regression Baseline

R2 完成后重新运行全部四组：

```text
planner declared:
327 / 0 fail

planner full:
676 / 9 fail
same cases only

codex bridge declared:
175 / 0 fail

codex bridge full:
220 total
219 pass
1 fail
same case only
```

不得：

- 修复 pre-existing failures。
- 隐藏 failure。
- 只报告 `npm test`。

---

# 31. R1 Regression

额外必须：

```text
R1 82 / 82 pass
```

如果 R2 新增 Adapter method：

新增测试应增加总数，但：

```text
原 82 个测试必须全部继续通过
```

---

# 32. Protected Hashes

13 个 protected files：

```text
13 / 13 match
```

仍使用：

```text
SHA-256
```

并从正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

执行。

不要以 mtime 判断。

---

# 33. R2 Definition of Done

全部满足才可宣布完成。

## Domain

- [ ] Session schema implemented。
- [ ] Message schema implemented。
- [ ] Gateway Event schema implemented。
- [ ] DSH seq 与 Gateway sequence 严格分离。
- [ ] deterministic message ids。
- [ ] unknown events fail-visible。

## Status

- [ ] status vocabulary centralized。
- [ ] 规格“九状态 vs 实际 8 值”已记录。
- [ ] state machine implemented。
- [ ] transition table documented。
- [ ] production transitions only use evidenced signals。
- [ ] transport disconnected semantics correct。
- [ ] cancel admission != quiescence 被正确建模。

## Sequence

- [ ] per-session monotonic sequence。
- [ ] concurrency-safe。
- [ ] seed supported。
- [ ] snapshot/restore interface exists。
- [ ] no disk persistence。

## Services

- [ ] sessions service。
- [ ] messages service。
- [ ] events service。
- [ ] session view store。
- [ ] no direct wire imports outside adapter boundary。

## Evidence

- [ ] `docs/r2-status-evidence.md`。
- [ ] title/created_at real-source audit。
- [ ] unsupported mappings explicitly documented。

## Tests

- [ ] all new R2 tests pass。
- [ ] original R1 tests still pass。
- [ ] all four external regression baselines unchanged。
- [ ] protected hashes 13/13。
- [ ] no secret leakage。
- [ ] no inbound listener。

## Scope

- [ ] no REST server。
- [ ] no phone WebSocket server。
- [ ] no Bearer auth。
- [ ] no disk persistence。
- [ ] no supervisor。
- [ ] no SSH/Tailscale changes。
- [ ] no debug UI。
- [ ] R3 not started。

---

# 34. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R2-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R1 baseline confirmation
3. Scope completed
4. Files created
5. Files modified
6. Domain architecture
7. Session schema
8. Message schema
9. Gateway event schema
10. Sequence model
11. Status vocabulary
12. Status evidence audit
13. State transition table
14. Title / created_at source audit
15. Adapter changes
16. Test results
17. R1 regression
18. External regression
19. Protected hash verification
20. Security review
21. Known limitations
22. Deferred to R3/R4/R5
23. R3 readiness
24. Exact stop statement
```

---

# 35. 报告必须逐项回答

1. R2 实际共有几个 status value？
2. 为什么不是擅自补一个“第九状态”？
3. `waiting_input` 的真实证据是什么？若无证据，是否避免生产映射？
4. `completed` 的真实证据是什么？
5. `cancelled` 是否只在收到可靠 completion evidence 后产生？
6. cancel admission 是否被错误等同为 quiescence？
7. Gateway sequence 是否独立于 DSH seq？
8. sequence 是否 per-session 严格递增？
9. 是否支持 seed？
10. 是否写入任何持久化文件？
11. 是否直接读取 zstd session log？
12. title 的真实来源是什么？
13. created_at 的真实来源是什么？
14. 如果字段无可靠来源，是否保持 null？
15. message ID 是否 deterministic？
16. unknown DSH events 是否被保留？
17. 是否新增 `session/control` Adapter capability？
18. 如果新增，R1 六方法是否完全兼容？
19. R1 原 82 tests 是否全绿？
20. 是否出现新的 external regression？
21. protected files 是否 13/13 unchanged？
22. 是否启动任何 inbound listener？
23. 是否进入 R3？

---

# 36. Stop Gate

完成 R2 后：

```text
R2 COMPLETE — STOPPING HERE.
```

不得创建或实现：

```text
src/remote/server.mjs
src/remote/http/*
src/remote/ws/server*
src/remote/persistence.mjs
src/remote/replay.mjs
src/remote/auth.mjs  # phone Bearer layer
public/debug/remote/*
scripts/dsh-start.ps1
scripts/dsh-stop.ps1
scripts/ssh-enable.ps1
```

不得：

```text
enable sshd
install Tailscale
change firewall
change DSH profile
modify .credentials.yaml
```

等待人工验收。

---

# 37. 给 DSH 的执行指令

现在执行：

```text
Phase R2 — Session / Message / Event Domain Model
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R1-REPORT.md
D:\DSH-testing\dsh-remote-gateway\README.md
D:\DSH-testing\REMOTE-MOBILE-R0-REPORT.md
D:\DSH-testing\docs\remote-mobile\ENVIRONMENT.md
```

然后：

1. 重新确认 R1 82 tests baseline。
2. 只读审计 DSH status/control/event wire。
3. 创建 `docs/r2-status-evidence.md`。
4. 实现 model/state/services。
5. 实现 in-memory Gateway sequence。
6. 必要时仅通过 Adapter 增加 control capability。
7. 完成 R2 tests。
8. 重跑 R1 tests。
9. 重跑四组 external regression。
10. 验证 13 protected hashes。
11. 生成 `PHASE-R2-REPORT.md`。
12. 停止。
13. 不进入 R3。

如果 status/control 的真实 wire 与 R0/R1 记录发生不兼容变化：

```text
STOP IMPLEMENTATION
```

在报告中输出：

```text
R2_WIRE_ASSUMPTION_INVALIDATED
```

附真实证据，不得绕过 version/wire guard。
