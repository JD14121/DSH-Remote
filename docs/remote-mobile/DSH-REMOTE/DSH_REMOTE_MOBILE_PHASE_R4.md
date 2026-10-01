# Phase R4 — Realtime WebSocket Event Stream

> 前置阶段：Phase R3 — Loopback REST API & StatusService
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段目标：在现有 loopback REST Server 上增加 **手机端未来消费的实时 WebSocket 事件流**，完成 Gateway Event fan-out、连接级 backpressure、heartbeat、断线重连协议，以及基于 **当前进程内 ring buffer** 的 `last_sequence` best-effort replay。
>
> **R4 不实现磁盘持久化。真正跨 Gateway 重启的 durable replay 仍属于 R5。**
>
> **R4 不实现 Phone Bearer Auth（R6）、DSH credential bootstrap / supervisor（R7）、Debug/Mobile UI（R8）、SSH/Tailscale（R9）。**
>
> 完成后生成 `PHASE-R4-REPORT.md` 并停止，不得自动进入 R5。

---

# 0. R3 验收基线

R3 已验收通过：

```text
R1 tests:       82 / 82
R2 tests:      113 / 113
R3 tests:      161 / 161
Full suite:    356 / 356
Runtime deps:  0
```

外部 baseline：

```text
planner declared:   327 / 0 fail
planner full:       676 / 9 fail
codex declared:     175 / 0 fail
codex full:         220 total / 219 pass / 1 fail
protected hashes:   13 / 13
UTF-8:              clean
```

R3 当前已提供：

```text
loopback HTTP server
Host fence
/api/v1 REST contract
SessionsService
MessagesService
EventsService
StatusService
SessionViewStore
GatewaySequenceAllocator
in-memory capped event log
```

R4 必须复用这些组件，不建立第二套状态或事件系统。

---

# 1. R4 核心范围

R4 交付：

```text
WS /api/v1/events
WebSocket protocol v1
Gateway-event subscriber registry
one-session-per-socket subscription
last_sequence reconnect contract
in-memory replay
replay gap detection
resync_required control frame
bounded per-client backlog
backpressure
heartbeat / dead-client detection
upgrade Host fence
WebSocket Origin fence
clean shutdown
fixture WebSocket client
protocol documentation
contract tests
```

R4 不交付：

```text
disk event journal
durable sequence across process restart
startup recovery
phone Bearer auth
token in WebSocket URL
TLS
rate limits / quota policy
mobile UI
DSH supervisor
real credential bootstrap
SSH / Tailscale
```

---

# 2. 最终链路

```text
Phone GPT-like UI
       │
       │ REST
       ├──────────────► /api/v1/sessions/...
       │
       │ WebSocket
       ▼
WS /api/v1/events
       │
       ▼
WebSocket Session
       │
       ▼
Subscriber Registry
       │
       ▼
EventsService
       │
       ▼
StatusService / DshAdapter
       │
       ▼
DSH
```

R4 不能直接订阅 DSH wire。

唯一允许关系：

```text
WS layer
   ↓
Gateway Event / EventsService
   ↓
R2/R3 services
   ↓
DshAdapter
```

禁止：

```text
ws/* → wire/*
ws/* → Typert endpoint
ws/* → DSH raw SessionFollowFrame
```

---

# 3. 推荐文件结构

创建：

```text
src/remote/ws/
  protocol.mjs
  server.mjs
  subscriber-registry.mjs
  client-session.mjs
  backlog.mjs
  replay.mjs
  heartbeat.mjs
  validation.mjs
  close-codes.mjs

tests/remote/
  ws-handshake.test.mjs
  ws-protocol.test.mjs
  ws-events.test.mjs
  ws-replay.test.mjs
  ws-resync.test.mjs
  ws-backpressure.test.mjs
  ws-heartbeat.test.mjs
  ws-origin-security.test.mjs
  ws-shutdown.test.mjs
  ws-integration.test.mjs

scripts/
  r4-fixture-ws-client.mjs

docs/
  r4-websocket-contract.md
  r4-reconnect-semantics.md
```

可合理调整文件名，但职责必须清晰。

---

# 4. WebSocket Server Implementation

Node 24 没有适合直接作为 production WebSocket server 的高层内置接口。

R4 不应为了维持“0 runtime dependencies”而手写完整 RFC 6455 framing、masking、fragmentation 和 ping/pong。

推荐：

```text
使用成熟的 WebSocket server package，例如 `ws`
```

规则：

1. 如引入 `ws`，它应成为 R4 唯一或极少数新增 runtime dependency。
2. `package-lock.json` 必须记录精确解析版本。
3. `PHASE-R4-REPORT.md` 必须记录为什么引入。
4. 不得使用大型 Web framework。
5. 不得为了 zero-dependency 指标牺牲 protocol correctness。

如果当前环境已有等价且经过验证的 WebSocket server capability，可使用，但必须在报告说明。

---

# 5. Same-Port Upgrade

WebSocket 必须复用 R3 HTTP server：

```text
127.0.0.1:9445
```

不得另开：

```text
9446
9450
...
```

路径：

```text
GET /api/v1/events
Upgrade: websocket
```

HTTP REST 和 WebSocket 共用：

```text
same host
same port
same loopback restriction
same lifecycle
```

---

# 6. WebSocket URL

标准形式：

```text
ws://127.0.0.1:9445/api/v1/events?session_id=<session-id>
```

重连：

```text
ws://127.0.0.1:9445/api/v1/events?session_id=<session-id>&last_sequence=<n>
```

Query：

```text
session_id      required
last_sequence   optional
```

`last_sequence` 是：

```text
Gateway Event sequence
```

不是：

```text
DSH durable source sequence
message history cursor
HTTP request_id
client_message_id
```

---

# 7. Protocol Version

使用 WebSocket subprotocol：

```text
dsh-remote-v1
```

浏览器：

```js
new WebSocket(url, "dsh-remote-v1")
```

Upgrade request 若没有支持的 subprotocol：

推荐：

```text
426 Upgrade Required
```

或明确的 pre-upgrade rejection。

不得静默降级到未知协议。

协议版本必须在：

```text
src/remote/ws/protocol.mjs
```

集中定义。

---

# 8. Upgrade Security

R3 的 Host fence 在普通 HTTP routing 之前执行。

**Node `upgrade` event 会绕过正常 HTTP route handler。**

因此 R4 必须显式把同一安全策略应用到 Upgrade path。

Upgrade 前必须验证：

```text
bind remains loopback
Host header
path
query
WebSocket version
Sec-WebSocket-Key
subprotocol
Origin
```

任何失败：

```text
在 WebSocket handshake 前用 HTTP 错误拒绝
```

不要先 101 再关闭，除非只有连接后才能判断的状态。

---

# 9. Host Fence

必须复用 R3 的同一个 Host authority validator。

禁止复制第二份不同逻辑。

允许：

```text
127.0.0.1:<server-port>
localhost:<server-port>
[::1]:<server-port>
```

禁止：

```text
wrong port
LAN host
public host
X-Forwarded-Host override
Forwarded override
```

注意：

R9 SSH Local Forward 验收应优先使用相同本地端口：

```text
9445 → PC 127.0.0.1:9445
```

这样 Host authority 与 server-port 规则一致。

R4 不为未来反向代理放宽 Host fence。

---

# 10. Origin Fence

WebSocket 不受浏览器 CORS 保护。

因此即使 R6 Bearer Auth 尚未实现，R4 也必须防止：

```text
malicious website
→ browser
→ ws://127.0.0.1:9445
```

允许：

```text
Origin absent
```

用于 native/diagnostic clients。

如果 Origin 存在，只允许与 loopback Gateway 同源：

```text
http://127.0.0.1:<port>
http://localhost:<port>
http://[::1]:<port>
```

任何外部 Origin：

```text
403
```

例如：

```text
https://evil.example
https://random-site.com
```

必须拒绝。

R6 可以进一步收紧认证，但 R4 不能把 CSWSH 风险留到以后。

---

# 11. Authentication Seam

R4 **不实现 Phone Bearer Auth**。

同时：

**禁止把未来 auth token 放入：**

```text
?token=
?access_token=
?bearer=
```

原因：

- URL 容易进入日志/history。
- 浏览器 WebSocket 不能任意设置 `Authorization` header。
- R6 需要专门设计 browser-compatible auth。

R4 应预留：

```js
authorizeUpgrade(request)
```

或等价 injectable seam。

R4 默认实现：

```text
loopback + Host + Origin policy only
```

R6 将替换/扩展该 seam。

---

# 12. Session Model: One Session Per Socket

R4 v1：

```text
one WebSocket connection
=
one DSH session subscription
```

优点：

- reconnect watermark 简单。
- backlog 隔离。
- 权限边界简单。
- 手机打开一个聊天页面时自然对应一个 socket。

R4 不实现：

```text
一个 socket 动态 subscribe/unsubscribe 多 session
```

如果未来需要，可升级协议版本。

---

# 13. Connection Lifecycle

状态：

```text
UPGRADING
CONNECTED
REPLAYING
LIVE
CLOSING
CLOSED
```

连接成功后：

1. 注册 client session。
2. 原子捕获 replay boundary。
3. 发送 `hello`。
4. 如有 `last_sequence`，执行 replay。
5. 发送 `replay_complete`。
6. 切换 `LIVE`。
7. 持续 fan-out Gateway Events。

不得：

```text
先 replay
再注册 live subscriber
```

否则 replay 期间发生的事件可能丢失。

---

# 14. Hello Frame

连接后第一条 application frame：

```json
{
  "type": "hello",
  "api_version": 1,
  "protocol": "dsh-remote-v1",
  "connection_id": "uuid",
  "session_id": "session-...",
  "server_time": "2026-09-19T...",
  "sequence": {
    "latest": 142,
    "earliest_available": 18
  },
  "replay": {
    "requested_from": 120,
    "mode": "replay"
  }
}
```

若无 `last_sequence`：

```json
"replay": {
  "requested_from": null,
  "mode": "live_only"
}
```

`hello`：

```text
不是 Gateway Event
不消耗 Gateway sequence
```

---

# 15. Event Frame

所有实时 domain events：

```json
{
  "type": "event",
  "event": {
    "sequence": 143,
    "event": "assistant.delta",
    "session_id": "session-...",
    "timestamp": null,
    "observed_at": "...",
    "data": {...},
    "source_sequence": null
  }
}
```

内部 `event` 必须是：

```text
R2 Gateway Event
```

不得在 WS 层重新构造另一种 status/message event vocabulary。

---

# 16. Replay Complete Frame

当 best-effort replay 完成：

```json
{
  "type": "replay_complete",
  "session_id": "...",
  "from_sequence": 120,
  "through_sequence": 142,
  "replayed": 22
}
```

该 frame：

```text
不消耗 Gateway sequence
```

若没有 replay：

可省略，或：

```json
{
  "type": "replay_complete",
  "replayed": 0
}
```

全项目统一即可。

---

# 17. Heartbeat Frame

应用层 heartbeat：

```json
{
  "type": "heartbeat",
  "server_time": "...",
  "session_id": "...",
  "latest_sequence": 150
}
```

Heartbeat：

```text
不是 Gateway Event
不消耗 Gateway sequence
```

推荐：

```text
DSH_REMOTE_WS_HEARTBEAT_MS=25000
```

范围 validation：

```text
10s..60s
```

---

# 18. Protocol-Level Ping/Pong

除 application heartbeat 外，WebSocket server 应使用 RFC6455：

```text
ping / pong
```

检测死连接。

推荐：

```text
每 25s ping
下一个周期仍未 pong → terminate
```

浏览器自动处理 pong。

application heartbeat 用于 UI/diagnostic。

protocol ping/pong 用于 transport liveness。

两者不要混用 sequence。

---

# 19. Event Subscriber Registry

新增：

```text
subscriber-registry.mjs
```

职责：

```text
sessionId → client sessions
```

操作：

```js
subscribe(sessionId, client)
unsubscribe(sessionId, client)
publish(event)
count(sessionId)
closeAll()
```

要求：

- per-session isolation。
- one event → every subscriber of same session。
- no cross-session leak。
- subscriber failure 不影响 sibling。
- unsubscribe idempotent。
- server.stop 清空所有 subscriber。

---

# 20. EventsService Integration

R3 已经有：

```text
EventsService
+
in-memory capped event log
```

R4 应优先复用它。

允许对 `EventsService` 做 additive extension，例如：

```js
eventsService.subscribe(listener)
eventsService.eventsAfter(sessionId, sequence)
eventsService.sequenceBounds(sessionId)
```

或等价接口。

禁止建立第二个独立 event log。

必须保持：

```text
R2/R3 tests 全绿
```

---

# 21. Replay Source

R4 replay 只允许来源：

```text
现有 in-memory Gateway Event ring
```

不得：

- 读 zstd。
- 读磁盘 JSONL。
- 从 DSH durable history 伪造 Gateway Event replay。
- 重新生成旧 Gateway sequence。

R5 才提供 durable journal。

---

# 22. Replay Semantics

客户端最后确认看到：

```text
last_sequence = N
```

server 应发送：

```text
所有 sequence > N
```

且：

```text
strict ascending
no duplicate
no gap
```

前提：

```text
ring buffer 仍保留完整 gap
```

---

# 23. Replay Bounds

需要：

```js
earliestAvailable(sessionId)
latestAvailable(sessionId)
eventsAfter(sessionId, lastSequence)
```

语义：

### Case A

```text
last_sequence == latest
```

→ 直接 LIVE。

### Case B

```text
earliest-1 <= last_sequence < latest
```

→ replay `last_sequence+1 ... latest`。

### Case C

```text
last_sequence < earliest-1
```

→ gap 已被 ring buffer 淘汰：

```text
RESYNC_REQUIRED
```

### Case D

```text
last_sequence > latest
```

→ 可能 Gateway 已重启、client watermark 属于旧 process：

```text
RESYNC_REQUIRED
```

不能假装“客户端已经领先”。

---

# 24. Resync Required

若无法完整 replay：

先发送：

```json
{
  "type": "resync_required",
  "session_id": "...",
  "reason": "gap_not_available",
  "requested_sequence": 10,
  "earliest_available": 50,
  "latest_available": 140,
  "action": "refresh_rest_state"
}
```

然后关闭：

```text
close code 4001
reason RESYNC_REQUIRED
```

另一个 reason：

```text
sequence_ahead_of_server
```

手机未来行为：

```text
GET session
GET message history
read fresh session.last_sequence
reconnect WS with new last_sequence
```

---

# 25. Why R4 Does Some Replay

R4 实现：

```text
best-effort in-memory replay
```

因为它：

- 定义 `last_sequence` wire contract。
- 解决短时网络抖动。
- 允许手机在 Gateway 未重启时补回漏掉事件。
- 给 R5 提供清晰 persistence seam。

R4 **不声称**：

```text
Gateway restart 后仍能 replay
```

R5 才把 ring buffer 变为 durable source。

---

# 26. Atomic Replay → Live Handoff

必须防止：

```text
replay 读到 latest=100
此时 event 101 到达
subscriber 尚未注册
→ 101 永久丢失
```

正确策略：

```text
register subscriber first
↓
capture replay boundary
↓
new live events temporarily queue for this client
↓
send historical replay
↓
flush queued live events
↓
LIVE
```

必须测试 race：

```text
event arrives during replay
```

结果：

```text
exactly once
strict sequence order
```

---

# 27. Per-Client Backlog

每个 socket 必须有独立 outbound queue。

默认建议：

```text
DSH_REMOTE_WS_MAX_BACKLOG_EVENTS=256
DSH_REMOTE_WS_MAX_BACKLOG_BYTES=1048576
```

均可配置并做合理范围 validation。

backlog 统计：

```text
尚未成功交给 socket send callback 的 serialized frames
```

不要按 JS object 数量估算 byte size。

---

# 28. Backpressure

发送应 serialise 为单 writer pump：

```text
queue
↓
send one frame
↓
send callback
↓
send next
```

这样：

- 保持 order。
- 可精确知道 pending bytes。
- 不依赖 socket OS buffer 无限增长。

可以参考 `ws.bufferedAmount` 作为辅助指标，但不能把它作为唯一限流机制。

---

# 29. Backlog Overflow

达到：

```text
event limit
OR
byte limit
```

时：

尽量发送：

```json
{
  "type": "overflow",
  "session_id": "...",
  "last_delivered_sequence": 120,
  "latest_sequence": 180,
  "action": "reconnect_with_last_sequence"
}
```

然后关闭：

```text
close code 4003
reason BACKLOG_OVERFLOW
```

如果连接已经无法发送 frame：

直接 close/terminate。

不得：

```text
静默 drop oldest
静默 drop newest
```

对手机聊天流来说 silent drop 是不可接受的。

---

# 30. Client Ack

R4 v1 不要求 application ACK protocol。

客户端负责保存：

```text
last successfully processed Gateway event sequence
```

重连时发送：

```text
last_sequence
```

不要把 server `send()` callback 当成“手机已经处理”。

未来需要 stronger delivery guarantee 时再升级 protocol。

---

# 31. Unknown Client Messages

R4 v1 server 不需要业务级 client → server messages。

发送 prompt 仍走 REST。

若 client 向 socket 发送 application data：

推荐：

```text
protocol error
close 1008 or app code 4004
```

或只允许一个明确：

```json
{"type":"client_ping"}
```

但不要创造第二套 command channel。

**手机指令必须继续走 REST。**

这样：

```text
REST = commands
WS   = events
```

职责清晰。

---

# 32. Invalid Session

session_id syntax 在 handshake 前验证。

若 syntax invalid：

```text
HTTP 400
```

若 syntax 合法但 session 不存在：

可在握手后：

```json
{
  "type": "error",
  "error": {
    "code": "SESSION_NOT_FOUND"
  }
}
```

然后：

```text
close 4002
```

但如果可以可靠在 `handleUpgrade` 前查询而不引入 race，也可 HTTP 404。

项目选择一种并固定 contract。

不得泄漏 raw DSH error。

---

# 33. Close Codes

集中：

```text
src/remote/ws/close-codes.mjs
```

建议：

```text
1000 NORMAL
1002 PROTOCOL_ERROR
1008 POLICY_VIOLATION
1011 INTERNAL_ERROR
1013 TRY_AGAIN_LATER

4001 RESYNC_REQUIRED
4002 SESSION_NOT_FOUND
4003 BACKLOG_OVERFLOW
4004 CLIENT_MESSAGE_NOT_ALLOWED
```

App close code 必须位于：

```text
3000–4999
```

并在 contract 文档定义。

---

# 34. Error Frame

连接后 error：

```json
{
  "type": "error",
  "error": {
    "code": "...",
    "message": "...",
    "retryable": false,
    "connection_id": "..."
  }
}
```

禁止：

```text
stack
cause
cookie
token
Authorization
credentials
DSH_HOME
filesystem path
raw wire object
```

复用现有 redaction/allowlist 原则。

---

# 35. Session State Synchronization

R3 REST session object 已包含：

```text
last_sequence
```

推荐手机未来流程：

```text
1. GET /api/v1/sessions/:id
2. 保存 response.last_sequence = N
3. GET message history
4. WS connect ?session_id=id&last_sequence=N
5. server replay N 后发生的 Gateway Events
6. switch LIVE
```

这样能关闭：

```text
REST snapshot
→ WS connect
```

之间的 race。

---

# 36. Gateway Restart Semantics

R4 必须明确：

```text
R4 sequence is still process-local
```

Gateway restart 后：

```text
ring lost
sequence allocator currently may restart unless R5 seed
```

因此旧 client 的：

```text
last_sequence
```

可能大于新 server latest。

必须返回：

```text
RESYNC_REQUIRED
sequence_ahead_of_server
```

而不是：

```text
no events
```

R5 以后这条路径会变为 durable recovery。

---

# 37. waiting_input Semantics

继续继承 R2/R3：

```text
waiting_input
```

是 live-only。

如果当前 process 已观察到：

```text
user-questions/request
```

则 WS 正常发布：

```text
session.status → waiting_input
```

Gateway fresh restart 后：

不得 replay 一个并不存在的 waiting_input event。

R4 resync 不能修复这一点。

报告继续明确：

```text
absence of waiting_input evidence != idle
```

---

# 38. Heartbeat Does Not Change Domain State

应用 heartbeat 或 pong timeout：

不直接产生：

```text
session.status
```

WebSocket client 与 Gateway 断开：

```text
只是 phone transport 断开
```

不能把 DSH session 设置成：

```text
disconnected
```

R2 的 `disconnected` 专指：

```text
Gateway ↔ DSH transport loss
```

必须测试这两个概念不混淆。

---

# 39. Server Shutdown

R3：

```text
HTTP stop
→ StatusService stop
→ adapter.close
```

R4 加入 WS 后建议：

```text
stop accepting HTTP/upgrades
↓
send server_shutdown to active WS clients
↓
close WS clients
↓
stop heartbeat timers
↓
subscriber registry empty
↓
StatusService stop
↓
adapter.close
↓
close HTTP server
```

具体顺序要避免新事件进入已关闭 registry。

必须测试：

- no timer leaks。
- no open sockets。
- no subscriber leak。
- stop idempotent。

---

# 40. Server Shutdown Frame

建议：

```json
{
  "type": "server_shutdown",
  "retryable": true
}
```

然后 close：

```text
1001 Going Away
```

不消耗 Gateway sequence。

---

# 41. WebSocket Route Must Not Pollute REST Router

R3 HTTP route table 当前明确只有七条 REST routes。

R4 WS：

```text
Upgrade route
```

不应伪装成普通 REST GET route。

要求：

- HTTP GET `/api/v1/events` without Upgrade → 426 or documented 400/404。
- WebSocket Upgrade `/api/v1/events` → WS handler。
- REST route-table tests更新时明确区分 HTTP vs Upgrade。

不得破坏：

```text
404 vs 405
Host fence
```

---

# 42. Dependency Isolation

`src/remote/ws/*` 可 import：

```text
EventsService public surface
Session services
R2/R3 models
HTTP config/security helpers
redact helpers
```

不得 import：

```text
wire/*
DSH internal package
DSH endpoint strings
zstd
.credentials.yaml
```

新增 isolation test 扫描源码。

---

# 43. Fixture WebSocket Client

创建：

```text
scripts/r4-fixture-ws-client.mjs
```

用途：

- 连接 synthetic R3 fixture server + R4 WS。
- 展示 hello。
- 展示 event。
- 测试 last_sequence reconnect。
- 展示 heartbeat。
- 展示 resync_required。

必须使用：

```text
synthetic fixture events
```

不得连接真实 DSH。

脚本 console banner 用 ASCII，避免 Windows codepage 混淆。

---

# 44. R4 Documentation

创建：

```text
docs/r4-websocket-contract.md
docs/r4-reconnect-semantics.md
```

`r4-websocket-contract.md` 至少包含：

```text
URL
query
subprotocol
hello
event
heartbeat
replay_complete
resync_required
overflow
error
server_shutdown
close codes
sequence semantics
Origin policy
security limitation
```

`r4-reconnect-semantics.md` 至少包含：

```text
normal reconnect
short disconnect with replay
ring buffer gap
sequence ahead after restart
backlog overflow
server shutdown
mobile algorithm
R5 upgrade path
```

---

# 45. R4 Tests

至少：

```text
ws-handshake.test.mjs
ws-protocol.test.mjs
ws-events.test.mjs
ws-replay.test.mjs
ws-resync.test.mjs
ws-backpressure.test.mjs
ws-heartbeat.test.mjs
ws-origin-security.test.mjs
ws-shutdown.test.mjs
ws-integration.test.mjs
```

---

# 46. Handshake Tests

覆盖：

```text
valid upgrade
wrong path
missing session_id
invalid session_id
bad Host
wrong port
external Origin
allowed loopback Origin
absent Origin
missing subprotocol
wrong subprotocol
normal HTTP GET /events
```

保证：

```text
bad Host / Origin rejected before 101
```

---

# 47. Event Tests

覆盖：

```text
same-session delivery
cross-session isolation
two clients same session
unsubscribe one keeps sibling
status event
assistant.start
assistant.delta
assistant.end
message.created
unknown event
source_sequence preserved
Gateway sequence preserved
```

---

# 48. Replay Tests

覆盖：

```text
last_sequence == latest
one-event replay
many-event replay
strict order
no duplicate
event arrives during replay
live handoff
earliest-1 boundary
```

关键 race：

```text
new event while replaying
```

必须：

```text
exactly once
strictly ordered
```

---

# 49. Resync Tests

覆盖：

```text
last_sequence older than ring
last_sequence ahead of server
empty ring + stale watermark
server restart simulation
resync_required frame
close 4001
no false claim of complete replay
```

---

# 50. Backpressure Tests

使用 intentionally slow/fake socket：

```text
frames queue
order preserved
byte accounting correct
event limit
byte limit
overflow frame
close 4003
sibling unaffected
no silent drop
```

不要用真实网络速度决定 test。

---

# 51. Heartbeat Tests

使用 fake timers 或 injectable clock：

```text
application heartbeat emitted
heartbeat consumes no Gateway sequence
ping sent
pong marks alive
missing pong terminates
timers cleared on close
phone heartbeat loss does not mark DSH session disconnected
```

测试不得真的 sleep 25 秒。

---

# 52. Shutdown Tests

覆盖：

```text
server_shutdown frame
1001 close
subscriber registry empty
backlog cleared
heartbeat stopped
HTTP rejects new upgrade
StatusService stopped
adapter.close exactly once
stop idempotent
```

---

# 53. Integration Test

模拟：

```text
GET /sessions/:id
→ last_sequence = 10

WS connect last_sequence=10
→ hello
→ replay_complete 0
→ LIVE

POST /messages
→ 202

Gateway emits:
11 session.status running
12 assistant.start
13 assistant.delta
14 assistant.end
15 message.created
16 session.status completed

WS receives 11..16 in exact order

disconnect after processing 14

server emits:
17...
18...

reconnect last_sequence=14
→ hello
→ replay 15..18 exactly once
→ replay_complete
→ LIVE
```

验证：

- REST commands + WS events 分工明确。
- no DSH raw frame leak。
- no cross-session leak。
- no sequence confusion。
- reconnect contract works。

---

# 54. In-Memory Replay Capacity

R2/R3 当前 ring 默认：

```text
1000 events/session
```

R4 可以继续使用该默认，或集中配置。

不要悄悄修改 R2 constant。

若配置化：

```text
DSH_REMOTE_EVENT_RING_SIZE
```

必须：

```text
bounded
safe integer
documented
tested
```

R5 将使用 durable journal，不代表 R4 ring 取消；ring 仍可作为 hot cache。

---

# 55. No Durable Persistence

R4 product modules 不得新增：

```text
fs.writeFile
fs.appendFile
createWriteStream
SQLite
JSONL journal
$DSH_HOME\remote
```

除：

```text
package-lock.json
docs/tests/source files
```

之外，不得写运行态持久化。

fixture/test temporary files若必要，必须位于 test temp location 且非 product path。

---

# 56. No Phone Auth Yet

R4 不得实现：

```text
Bearer verification
token query
login endpoint
cookie issuance
JWT
API key file
```

只预留 auth seam。

R6 才完成。

R4 report 必须明确：

```text
Until R6, WS must remain loopback-only and must not be exposed directly.
```

---

# 57. No Real DSH Credential

继续：

- 不读 `.credentials.yaml`。
- 不 scrape console。
- 不 capture launch token。
- 不改 launcher。
- 不提前 R7。

真实 authenticated WebSocket smoke test：

```text
DEFER TO R7
```

fixture integration足以验收 R4 protocol。

---

# 58. Source Editing Safety

继续 R3 gate：

禁止使用 PowerShell：

```text
Set-Content
Out-File
Add-Content
```

修改源码。

完成扫描：

```text
U+FFFD = 0
invalid UTF-8 = 0
```

严格 decode。

---

# 59. Regression Requirements

R4 完成后：

```text
R1 82 / 82
R2 113 / 113
R3 161 / 161
R4 new tests all green
```

外部：

```text
planner declared: 327 / 0
planner full:     676 / 9 same cases
codex declared:   175 / 0
codex full:       220 / 219 / 1 same case
```

protected：

```text
13 / 13 SHA-256
```

CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

# 60. R4 Definition of Done

## WebSocket

- [ ] same-port upgrade。
- [ ] `/api/v1/events`。
- [ ] `dsh-remote-v1`。
- [ ] one-session-per-socket。
- [ ] hello frame。
- [ ] event frame。
- [ ] heartbeat。
- [ ] replay_complete。
- [ ] resync_required。
- [ ] overflow。
- [ ] error。
- [ ] server_shutdown。
- [ ] documented close codes。

## Security

- [ ] loopback only。
- [ ] Host fence applies to upgrade。
- [ ] Origin fence。
- [ ] no token in query。
- [ ] no wildcard Origin policy。
- [ ] no raw DSH errors/secrets。

## Event fan-out

- [ ] subscriber registry。
- [ ] same-session multi-client fan-out。
- [ ] cross-session isolation。
- [ ] no duplicate DSH subscriptions added by WS layer。
- [ ] WS consumes Gateway Events only。

## Replay

- [ ] optional `last_sequence`。
- [ ] in-memory replay。
- [ ] strict ordering。
- [ ] replay/live atomic handoff。
- [ ] gap detection。
- [ ] ahead-of-server detection。
- [ ] `RESYNC_REQUIRED`。
- [ ] no claim of restart durability。

## Backpressure

- [ ] per-client bounded backlog。
- [ ] event limit。
- [ ] byte limit。
- [ ] no silent drop。
- [ ] overflow close。
- [ ] sibling unaffected。

## Liveness

- [ ] WS ping/pong。
- [ ] app heartbeat。
- [ ] dead client cleanup。
- [ ] no domain-status mutation from phone disconnect。

## Shutdown

- [ ] no new upgrades。
- [ ] clients notified。
- [ ] sockets closed。
- [ ] timers cleaned。
- [ ] registry empty。
- [ ] StatusService stopped。
- [ ] adapter closed。
- [ ] idempotent stop。

## Scope

- [ ] no durable persistence。
- [ ] no phone auth。
- [ ] no supervisor。
- [ ] no UI。
- [ ] no SSH/Tailscale。
- [ ] R5 not started。

## Regression

- [ ] R1 green。
- [ ] R2 green。
- [ ] R3 green。
- [ ] R4 green。
- [ ] external baselines unchanged。
- [ ] protected 13/13。
- [ ] UTF-8 clean。

---

# 61. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R4-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R3 baseline confirmation
3. Scope completed
4. Files created
5. Files modified
6. Dependency decision
7. WebSocket architecture
8. Upgrade path
9. Host / Origin security
10. Protocol version
11. Frame schemas
12. Close-code table
13. Subscriber registry
14. EventsService changes
15. Replay algorithm
16. Atomic replay/live handoff
17. Resync semantics
18. Backpressure
19. Heartbeat / ping-pong
20. Shutdown lifecycle
21. Fixture client
22. Test results
23. R1/R2/R3 regression
24. External regression
25. Protected hashes
26. UTF-8 verification
27. Security review
28. Known limitations
29. Deferred R5/R6/R7/R8/R9
30. R5 readiness
31. Exact stop statement
```

---

# 62. 报告必须逐项回答

1. WebSocket 是否复用 9445？
2. 是否新开第二个监听端口？
3. Upgrade 是否经过 Host fence？
4. 是否验证 Origin？
5. 外部网站 Origin 是否被拒绝？
6. 是否把 token 放进 WS URL？
7. 使用什么 subprotocol？
8. 一个 socket 能订阅几个 session？
9. `last_sequence` 的语义是什么？
10. 它是否与 DSH source sequence 混淆？
11. replay 来源是什么？
12. 是否读取任何 durable file 做 replay？
13. ring gap 时发生什么？
14. sequence ahead 时发生什么？
15. 是否发送 `resync_required`？
16. replay 到 live 的 handoff 如何避免 race？
17. replay 期间产生的新 event 会不会丢？
18. 是否可能重复发送同一 sequence？
19. backlog 默认 event/byte limits？
20. overflow 是否 silent drop？
21. overflow 后 close code？
22. heartbeat 是否消耗 Gateway sequence？
23. phone WS disconnect 是否错误地把 DSH session 标为 disconnected？
24. 是否使用 ping/pong？
25. dead client 如何清理？
26. server shutdown 是否清除所有 timer/subscriber/socket？
27. 是否新增 runtime dependency？
28. 若有，为什么不是手写 WebSocket protocol？
29. 是否读取 `.credentials.yaml`？
30. 是否写 durable persistence？
31. 是否创建 phone auth？
32. R1/R2/R3 tests 是否全绿？
33. R4 新测试数量？
34. external regression 是否有新增 fail？
35. protected hashes 是否 13/13？
36. UTF-8 scan 是否 clean？
37. 是否进入 R5？

---

# 63. Stop Gate

完成 R4 后输出：

```text
R4 COMPLETE — STOPPING HERE.
```

不得创建/实现：

```text
src/remote/persistence.mjs
src/remote/replay-durable.mjs
src/remote/auth.mjs          # phone auth
public/debug/remote/*
scripts/dsh-start.ps1
scripts/dsh-stop.ps1
scripts/dsh-restart.ps1
scripts/ssh-enable.ps1
```

不得：

```text
write $DSH_HOME\remote
enable sshd
install Tailscale
open firewall
modify DSH profile
read .credentials.yaml
capture real DSH token
```

等待人工验收。

---

# 64. 给 DSH 的执行指令

现在执行：

```text
Phase R4 — Realtime WebSocket Event Stream
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R3-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r3-rest-contract.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R2-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r2-status-evidence.md
```

执行顺序：

1. 确认 356/356 baseline。
2. 审计 `EventsService` 当前 ring/log API。
3. 决定最小 additive subscriber/replay seam。
4. 明确 WebSocket server dependency 策略。
5. 写 `docs/r4-websocket-contract.md`。
6. 写 `docs/r4-reconnect-semantics.md`。
7. 实现 same-port upgrade。
8. 实现 Host + Origin + protocol validation。
9. 实现 subscriber registry。
10. 实现 event fan-out。
11. 实现 in-memory `last_sequence` replay。
12. 实现 resync gap detection。
13. 实现 atomic replay→live handoff。
14. 实现 backlog/backpressure。
15. 实现 heartbeat + ping/pong。
16. 实现 shutdown。
17. 创建 fixture client。
18. 完成 R4 tests。
19. 重跑 R1/R2/R3。
20. 重跑 external baselines。
21. 验证 protected hashes。
22. UTF-8/U+FFFD scan。
23. 生成 `PHASE-R4-REPORT.md`。
24. STOP。
25. 不进入 R5。

如果发现 R3 event model 无法支持无丢失 fan-out：

```text
STOP IMPLEMENTATION
R4_EVENT_MODEL_ASSUMPTION_INVALIDATED
```

如果现有 ring buffer 无法可靠判断 replay gap：

```text
STOP IMPLEMENTATION
R4_REPLAY_BOUNDARY_UNRESOLVED
```

不得通过 silent drop、猜测 sequence 或重新生成旧事件来绕过。
