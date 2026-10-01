# Phase R3 — Loopback REST API & Status Service

> 前置阶段：Phase R2 — Session / Message / Event Domain Model
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段目标：在 R1 Adapter + R2 Domain/State 基础上建立 **手机端未来消费的 REST API v1**，并完成 control/follow → domain state 的 Status Service wiring。
>
> **R3 只实现 loopback HTTP REST API。**
>
> 不实现手机 WebSocket Server（R4）、磁盘持久化/replay（R5）、Phone Bearer Auth/CORS production policy（R6）、DSH supervisor/credential bootstrap（R7）、Debug UI（R8）、SSH/Tailscale（R9）。
>
> 完成 R3 后生成 `PHASE-R3-REPORT.md` 并停止，不得自动进入 R4。

---

# 0. R2 验收基线

R2 已验收通过：

```text
R1 tests:       82 / 82
R2 tests:      113 / 113
Project total: 195 / 195
```

外部 baseline：

```text
planner declared:   327 / 0 fail
planner full:       676 / 9 fail
codex declared:     175 / 0 fail
codex full:         220 total / 219 pass / 1 fail
protected hashes:   13 / 13
```

保持这些结果。

R2 已提供：

```text
DshAdapter
SessionsService
MessagesService
EventsService
SessionStateMachine
SessionViewStore
GatewaySequenceAllocator
Session / Message / GatewayEvent models
subscribeControl()
```

---

# 1. R3 范围

R3 交付：

```text
HTTP server
REST router
request validation
response/error envelope
Gateway-side session pagination
message history pagination contract
message submission endpoint
cancel endpoint
health endpoint
upload protocol
StatusService wiring
loopback bind enforcement
request size limits
graceful start/stop
REST contract tests
```

R3 不交付：

```text
Phone-facing WebSocket server
SSE
last_sequence replay
disk event journal
startup recovery
Bearer token auth
production CORS allowlist
TLS
PowerShell supervisor
real DSH launch-token bootstrap
debug/mobile UI
SSH / Tailscale
```

---

# 2. 核心架构

```text
future phone client
      │
      │ HTTP/JSON
      ▼
127.0.0.1:9445
      │
      ▼
R3 HTTP Server
      │
      ├── Router
      ├── Validation
      ├── Error mapping
      └── Status Service
             │
             ▼
      R2 Domain Services
             │
             ▼
          DshAdapter
             │
             ▼
      DSH Web RPC :3080
```

硬性边界：

```text
HTTP layer
    ↓
R2 services/domain
    ↓
DshAdapter
    ↓
wire/*
```

`http/*`、`server.mjs`、`status-service.mjs` 不得 import：

```text
src/remote/wire/*
```

不得写 DSH endpoint string。

---

# 3. 新增文件建议

```text
src/remote/
  server.mjs
  status-service.mjs
  uploads.mjs

  http/
    router.mjs
    routes.mjs
    request.mjs
    response.mjs
    errors.mjs
    validation.mjs
    pagination.mjs
    config.mjs

tests/remote/
  rest-health.test.mjs
  rest-sessions.test.mjs
  rest-messages.test.mjs
  rest-cancel.test.mjs
  rest-errors.test.mjs
  rest-pagination.test.mjs
  rest-bind-security.test.mjs
  rest-upload.test.mjs
  status-service.test.mjs
  rest-integration.test.mjs

scripts/
  r3-fixture-server.mjs

docs/
  r3-rest-contract.md
  r3-upload-evidence.md
```

实际命名可合理调整，但职责必须清晰。

---

# 4. Server Factory

创建概念 API：

```js
createRemoteHttpServer({
  sessionsService,
  messagesService,
  eventsService,
  statusService,
  uploadService,
  config
})
```

至少支持：

```js
await server.start()
await server.stop()
server.address()
```

不得在 import 时：

- bind port。
- 打开 socket。
- 读取真实 credential。
- 修改 DSH。
- 写磁盘状态。

---

# 5. Bind Policy

默认：

```text
DSH_REMOTE_HOST=127.0.0.1
DSH_REMOTE_PORT=9445
```

R3 必须 fail closed：

```text
0.0.0.0      → reject
::           → reject
LAN address  → reject
public IP    → reject
```

R3 production path 只允许 loopback：

```text
127.0.0.1
localhost
::1
```

如果 Node bind 行为对 `localhost` 有 IPv4/IPv6差异：

内部规范化并记录实际 bind。

测试可使用：

```text
127.0.0.1:0
```

让 OS 分配临时端口。

---

# 6. Host Header Fence

由于 R6 尚未实现 Phone Bearer Auth，R3 必须额外保护 loopback server。

默认只接受 Host authority 属于：

```text
127.0.0.1:<port>
localhost:<port>
[::1]:<port>
```

未知 Host：

```text
403
```

不要信任：

```text
X-Forwarded-Host
X-Forwarded-For
Forwarded
```

R3 不支持反向代理。

未来 SSH Local Forward 不需要这些 header。

---

# 7. CORS Policy in R3

R6 才实现正式 Origin policy。

R3：

```text
不发送 Access-Control-Allow-Origin: *
```

默认：

- same-origin browser request 可正常工作。
- cross-origin request 不主动授权。
- `OPTIONS` 若不是明确支持的 route → `405` 或受控拒绝。

不得为了调试添加：

```text
Access-Control-Allow-Origin: *
```

---

# 8. API Version

固定：

```text
/api/v1
```

所有 JSON response：

```text
Content-Type: application/json; charset=utf-8
```

建议包含：

```json
{
  "api_version": 1
}
```

但避免每个 nested object 重复。

---

# 9. Common Success Envelope

对资源 GET，可直接返回：

```json
{
  "data": ...
}
```

集合：

```json
{
  "data": [...],
  "page": {...}
}
```

command：

```json
{
  "data": {
    "accepted": true
  }
}
```

不要使用：

```text
HTTP 200 + {error:...}
```

错误必须使用非 2xx。

---

# 10. Common Error Envelope

统一：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session was not found.",
    "retryable": false,
    "request_id": "..."
  }
}
```

禁止暴露：

```text
stack
cause object
DSH cookie
launch token
Authorization
filesystem secret
raw internal exception
```

server logs 也必须经过现有 `redact.mjs`。

---

# 11. Request ID

每个 HTTP request 生成：

```text
request_id
```

用途：

- error correlation。
- server-side diagnostic。
- future logs。

它不同于：

```text
client_message_id
DSH requestId
Gateway event sequence
DSH source sequence
```

不得混用。

推荐：

```text
crypto.randomUUID()
```

如果客户端传：

```text
X-Request-Id
```

R3 默认不要信任其唯一性。

可以保留为：

```text
client_request_id
```

但 server 仍生成自己的 request_id。

---

# 12. GET /api/v1/health

返回：

```json
{
  "data": {
    "status": "ok",
    "gateway": "ready",
    "api_version": 1,
    "dsh": {
      "status": "unavailable|ready|degraded",
      "version": "0.1.5-rc.2"
    }
  }
}
```

不得返回：

- token。
- cookie。
- DSH_HOME 完整敏感信息。
- credentials path。
- process command line。
- full env。

由于 R7 尚未提供真实 DSH auth：

允许真实本机运行时：

```text
gateway = ready
dsh = unavailable
reason code = AUTH_UNAVAILABLE
```

但 `health` 本身仍可返回 200，表示 HTTP Gateway 正常。

可另加：

```text
ready: false
```

表达下游不可用。

不要将“HTTP server 正常”和“DSH 已认证”混成一个布尔值。

---

# 13. GET /api/v1/sessions

来源：

```text
SessionsService
```

不得直接：

```text
adapter.listSessions()
```

由 HTTP 层调用。

返回 Session mobile projection：

```json
{
  "id": "...",
  "title": null,
  "status": "idle",
  "created_at": null,
  "updated_at": "...",
  "last_sequence": 42
}
```

不得输出：

```text
metadata
raw DSH object
dsh_cursor
wire object
credential
```

---

# 14. Session List Pagination

R1/R2 已确认 DSH `session/list` 返回全量。

R3 必须在 Gateway 侧：

```text
bound + paginate
```

Query：

```text
?limit=50&cursor=<opaque>
```

默认：

```text
limit=50
```

最大：

```text
limit=200
```

排序必须 deterministic。

建议：

```text
updated_at DESC
id ASC
```

null `updated_at` 放最后。

cursor 必须 opaque，例如 base64url JSON：

```json
{
  "v": 1,
  "offset": 50,
  "sort": "updated_desc_id_asc"
}
```

R3 cursor 是：

```text
best-effort in-memory list cursor
```

不是 durable snapshot cursor。

报告必须说明：

session list 在分页期间若变化，可能发生轻微 shift；R5 不负责修这个，若未来需要 stable snapshot 再设计。

非法 cursor：

```text
400 INVALID_CURSOR
```

---

# 15. GET /api/v1/sessions/:sessionId

返回：

```text
Session mobile projection
```

不存在：

```text
404 SESSION_NOT_FOUND
```

URL path segment 必须 decode 后 validation。

不得允许：

```text
../
\
NUL
control chars
```

虽然 session id 不是 filesystem path，也必须拒绝 malformed ids。

推荐只允许：

```text
session-[A-Za-z0-9-]+
```

如果实际 DSH id grammar 更宽，以真实 audit 为准。

---

# 16. GET /api/v1/sessions/:sessionId/messages

Query 建议：

```text
through_seq
before_seq
limit
```

注意：

这些是：

```text
DSH durable message/history cursors
```

不是 Gateway realtime `last_sequence`。

响应：

```json
{
  "data": [...],
  "page": {
    "through_seq": 123,
    "before_seq": 100,
    "has_more": true,
    "next_before_seq": 80
  }
}
```

limit 默认：

```text
50
```

最大：

```text
200
```

HTTP 层不得读取 zstd。

---

# 17. POST /api/v1/sessions/:sessionId/messages

Request：

```json
{
  "content": "...",
  "client_message_id": "...",
  "mode": "steer"
}
```

允许未来扩展：

```json
{
  "content": [
    {"type":"text","text":"..."}
  ],
  "client_message_id":"...",
  "mode":"queue"
}
```

R3 不应破坏 R1 PromptContentPart。

---

## 17.1 busy mode policy

R3 现在需要给 API 一个明确策略。

采用：

```text
default mode = steer
```

理由：

当前 DSH GUI 配置：

```text
ui-conversation.busyEnter = steer
```

因此手机端默认行为应与电脑 DSH GUI 一致。

但：

- 客户端仍可显式传 `queue`。
- 不修改 DSH settings。
- 默认值只存在于 Gateway config。

配置：

```text
DSH_REMOTE_DEFAULT_PROMPT_MODE=steer
```

只允许：

```text
steer
queue
```

非法值：

```text
400 INVALID_PROMPT_MODE
```

---

## 17.2 client_message_id

必须：

```text
required
```

推荐 UUID，但不要强制只能 UUID，除非已有客户端 contract。

至少要求：

```text
non-empty string
max length
safe characters
```

它继续：

```text
client_message_id == DSH requestId
```

Server 不生成替代 id。

缺失：

```text
400 CLIENT_MESSAGE_ID_REQUIRED
```

---

## 17.3 Response

成功：

```text
202 Accepted
```

```json
{
  "data": {
    "accepted": true,
    "session_id": "...",
    "request_id": "<DSH requestId>",
    "mode": "steer"
  }
}
```

不要等模型完成后再返回 HTTP。

实时回答属于：

```text
R4 WebSocket
```

---

# 18. POST /api/v1/sessions/:sessionId/cancel

成功 admission：

```text
202 Accepted
```

```json
{
  "data": {
    "accepted": true,
    "session_id": "..."
  }
}
```

注意：

```text
accepted != quiescent
```

不得返回：

```text
status = cancelled
```

除非后续 status evidence 已观察到 `RUN_ABANDONED`。

cold session：

```text
409 SESSION_COLD
```

不存在的 session：

如果可以可靠区分：

```text
404 SESSION_NOT_FOUND
```

若 DSH 对 cancel 的 live registry 语义无法区分 cold/existence：

保持 R1 established mapping，不编造。

---

# 19. Adapter Error → HTTP Mapping

集中实现，不散落 route。

建议：

| Adapter/domain code | HTTP |
| --- | ---: |
| `SESSION_NOT_FOUND` | 404 |
| `SESSION_COLD` | 409 |
| `PROMPT_REJECTED` | 409 or 422,按子类 |
| `INVALID_PROMPT_MODE` | 400 |
| `INVALID_PROMPT_CONTENT` | 400 |
| `AUTH_UNAVAILABLE` | 503 |
| `AUTH_REJECTED` | 502 |
| `DSH_UNAVAILABLE` | 503 |
| `WIRE_VERSION_MISMATCH` | 503 |
| `WIRE_PROTOCOL_ERROR` | 502 |
| `STREAM_ABORTED` | 499-like semantics internally; externally use 409/503 as appropriate |
| unknown internal | 500 |

不要实际发非标准 HTTP 499，除非 Node/library 已明确支持且文档要求。

---

# 20. Status Service

创建：

```text
src/remote/status-service.mjs
```

这是 R3 的第一优先实现。

职责：

```text
subscribeControl()
    ↓
control baseline / queue / jobs
    ↓
normalized domain signals
    ↓
SessionStateMachine
    ↓
SessionViewStore
```

还需要消费必要的 session follow event：

```text
turn/start
turn/end
user-questions/request
api-session/error
```

通过：

```text
EventsService / DshAdapter
```

不得直接读 wire。

---

# 21. Control Frame Mapping

至少：

```text
queue non-empty
→ queued evidence

queue empty + no running job
→ QUEUE_EMPTY

job running
→ RUN_STARTED

job failed
→ TASK_FAILED

job killed
→ RUN_ABANDONED
```

必须严格依据 `docs/r2-status-evidence.md`。

禁止在 R3 发明新 raw mapping。

---

# 22. Follow Subscription Policy

R3 不应为所有历史 session 永久保持 follow stream。

建议：

```text
1 host-wide control stream
+
per-session follow only when:
  session is running/queued
  OR session was recently requested by REST
  OR a prompt was just accepted
```

要求：

- dedupe：同 session 最多一个 active follow。
- idle timeout 可关闭。
- server.stop() 必须全部 unsubscribe。
- transport error → state `disconnected`。
- reconnect/retry policy仍不实现 durable replay。

R3 可做有限的自动 resubscribe：

```text
fresh follow snapshot
```

但不得声称补齐断线期间所有 Gateway events。

真正 gap replay：

```text
R5
```

---

# 23. waiting_input Rule

R2 证明：

```text
waiting_input
```

来自：

```text
user-questions/request
```

且是 live-only。

因此 REST response 可以显示：

```text
waiting_input
```

仅当当前进程实际观察到该 signal。

Gateway 重启或断线恢复后：

不得恢复成 `waiting_input`，除非 DSH 再次发出证据。

报告必须明确：

```text
absence of evidence != idle
```

必要时 restored status 使用其它 control/follow evidence。

---

# 24. POST /api/v1/uploads

R3 要建立协议，但必须先做只读 wire audit。

生成：

```text
docs/r3-upload-evidence.md
```

确认当前 DSH：

- 上传 endpoint。
- HTTP method。
- content type。
- request shape。
- response receipt shape。
- receipt lifetime。
- attachment store semantics。
- error codes。
- max size（若 DSH 有）。
- filename/MIME handling。

如果 audit 与 R0 假设不符：

不要猜 endpoint。

在报告中写：

```text
R3_UPLOAD_WIRE_UNRESOLVED
```

并允许其成为唯一 deferred R3 API 项。

不得为了“接口齐全”私自读写 `.dsh/attachments`。

---

# 25. Upload API Contract

若 wire audit 成功，则：

```text
POST /api/v1/uploads
```

推荐：

```text
multipart/form-data
```

或若 DSH 原生 endpoint 必须 raw body：

Gateway 可接 multipart，再转换。

Response：

```json
{
  "data": {
    "attachment_id": "...",
    "name": "...",
    "media_type": "...",
    "size": 12345
  }
}
```

客户端之后在 message content 使用：

```json
{
  "type": "attachment",
  "attachment_id": "..."
}
```

Gateway 内部再转换为 DSH `receiptId`/PromptContentPart。

---

# 26. Upload Safety — R3 Minimum

完整 hardening 在 R6，但 R3 不能实现明显不安全的 upload。

必须从第一版就有：

- hard byte limit。
- filename normalization。
- basename only。
- reject `..` / slash / backslash / NUL。
- MIME format validation。
- no client-supplied server path。
- bounded in-memory buffering or safe temp strategy。
- aborted upload cleanup。

推荐默认：

```text
DSH_REMOTE_MAX_UPLOAD_BYTES=26214400
```

即 25 MiB。

如 DSH 本身限制更小：

使用更小值。

不要把 25 MiB 当成 DSH 官方限制。

---

# 27. JSON Body Limits

JSON request 默认：

```text
1 MiB
```

配置：

```text
DSH_REMOTE_MAX_JSON_BYTES=1048576
```

超过：

```text
413 PAYLOAD_TOO_LARGE
```

防止：

```text
unbounded JSON buffering
```

---

# 28. Content-Type Rules

JSON endpoints 接受：

```text
application/json
application/json; charset=utf-8
```

其它：

```text
415 UNSUPPORTED_MEDIA_TYPE
```

upload 按实际 upload contract。

---

# 29. Method Rules

已知 path + 错 method：

```text
405 Method Not Allowed
Allow: ...
```

未知 path：

```text
404 ROUTE_NOT_FOUND
```

不要把二者混为一谈。

---

# 30. Query Validation

所有 numeric query：

```text
safe integer
>= 0
```

`limit`：

```text
1..200
```

重复 query parameter：

建议：

```text
400
```

而不是随意取第一个。

未知 query parameter：

可忽略或拒绝，但全项目统一。

推荐 R3：

```text
reject unknown query keys
```

让 contract 更严格。

---

# 31. Graceful Shutdown

`server.stop()`：

顺序建议：

```text
stop accepting new HTTP
↓
close idle HTTP connections
↓
StatusService stop
↓
unsubscribe follow/control
↓
adapter.close()
```

不得：

```text
kill DSH process
```

R7 才管理进程。

---

# 32. No Real Credential Yet

R3 tests：

```text
fixture adapter / fixture auth
```

R3 不得为了 live server：

- scrape console。
- read `.credentials.yaml`。
- modify launcher。
- implement R7 token capture。

允许 auth-free manual run：

```text
health only
```

或 fixture server。

真实 authenticated smoke test：

```text
DEFER TO R7
```

不影响 R3 contract 验收。

---

# 33. Fixture Server

创建：

```text
scripts/r3-fixture-server.mjs
```

用于手工浏览 REST contract。

必须：

```text
bind 127.0.0.1 only
use synthetic fixture data only
print SYNTHETIC/FIXTURE banner
```

不得连接真实 DSH。

不得冒充 production server。

---

# 34. API Documentation

创建：

```text
docs/r3-rest-contract.md
```

至少包含：

```text
API version
base URL
endpoint list
request schemas
response schemas
HTTP codes
error envelope
pagination
prompt mode
id semantics
sequence semantics
known R3 limitations
R4/R5/R6 deferred pieces
```

特别说明四种 ID/sequence：

```text
HTTP request_id
client_message_id / DSH requestId
DSH durable source sequence
Gateway event sequence
```

---

# 35. Tests

新增至少：

```text
rest-health.test.mjs
rest-sessions.test.mjs
rest-messages.test.mjs
rest-cancel.test.mjs
rest-errors.test.mjs
rest-pagination.test.mjs
rest-bind-security.test.mjs
rest-upload.test.mjs
status-service.test.mjs
rest-integration.test.mjs
```

---

# 36. Health Tests

覆盖：

- Gateway ready。
- DSH ready。
- DSH AUTH_UNAVAILABLE。
- DSH unavailable。
- no secrets。
- version included。
- server itself healthy while downstream unavailable。

---

# 37. Sessions Tests

覆盖：

- list。
- sort。
- pagination。
- cursor。
- invalid cursor。
- limit。
- detail。
- not found。
- metadata not leaked。
- DSH cursor not leaked。
- created_at/title null preserved。

---

# 38. Messages Tests

覆盖：

- history。
- source ordering。
- pagination。
- invalid seq。
- deterministic message ids。
- POST prompt。
- default `steer`。
- explicit `queue`。
- invalid mode。
- missing client_message_id。
- idempotency preserved。
- 202 response。
- no waiting for assistant completion。

---

# 39. Cancel Tests

覆盖：

- 202 admission。
- SESSION_COLD → 409。
- admission does not set cancelled。
- later RUN_ABANDONED → cancelled。
- no process kill。
- no broad Node kill。

---

# 40. Status Service Tests

覆盖：

```text
control baseline
queue added
queue emptied
job running
job failed
job killed
follow turn/start
turn/end completed
turn/end aborted
user-questions/request
transport lost
transport restored
duplicate subscription prevention
shutdown unsubscribe
```

保证：

```text
cancel accepted != cancelled
```

---

# 41. Bind/Security Tests

实际启动 ephemeral HTTP server，验证：

```text
127.0.0.1 succeeds
0.0.0.0 config rejected
non-loopback config rejected
bad Host → 403
no wildcard CORS
oversized JSON → 413
wrong media type → 415
known path wrong method → 405
unknown path → 404
error has no stack/cause/secret
```

---

# 42. Upload Tests

若 upload wire resolved：

- filename normalization。
- traversal reject。
- max bytes。
- MIME validation。
- missing file。
- abort cleanup。
- synthetic receipt。
- no raw filesystem path returned。
- receipt mapping to message attachment。

若 upload wire unresolved：

`rest-upload.test.mjs` 必须验证：

```text
501 UPLOAD_NOT_AVAILABLE
```

而不是 silently accept。

并在 R3 report 标记未闭环。

---

# 43. Integration Test

模拟：

```text
GET /sessions
↓
GET /sessions/:id
↓
POST /messages (steer)
↓
202
↓
status running
↓
GET /sessions/:id
↓
POST /cancel
↓
202 admission
↓
status still running
↓
RUN_ABANDONED arrives
↓
GET /sessions/:id
↓
status cancelled
```

同时验证：

- no raw DSH object leak。
- no wire endpoint string in HTTP layer。
- sequence fields meanings correct。
- HTTP server never waits for final LLM response。

---

# 44. Dependency Policy

优先使用 Node 24 内置：

```text
node:http
node:url
node:crypto
Web APIs
```

不要引入：

```text
Express
Fastify
Koa
Nest
```

除非有明确、记录的必要性。

R1/R2 当前 zero runtime dependencies，应尽量保持。

---

# 45. Source Editing Safety

R2 曾发生：

```text
PowerShell Set-Content
→ UTF-8 comments corrupted
→ U+FFFD
```

因此 R3 明确禁止用以下命令修改项目源码：

```powershell
Set-Content
Out-File
Add-Content
```

除非明确指定并验证 UTF-8 no-BOM，且修改后进行 byte/UTF-8 validation。

优先：

- Node file APIs with explicit UTF-8。
- patch/file-edit tooling。

R3 完成后扫描：

```text
U+FFFD = 0
invalid UTF-8 = 0
```

---

# 46. No Persistence

R3 product modules 不得：

```text
write event JSONL
persist sequence
persist session views
create SQLite
write $DSH_HOME\remote
```

HTTP access logs 若实现：

默认：

```text
memory/console only
```

且经过 redaction。

正式 disk logging：

```text
R7
```

---

# 47. No R4 WebSocket

R3 只允许：

```text
outbound DSH WebSocket client
```

不得创建 phone-facing：

```text
WebSocketServer
upgrade handler
/api/v1/events
SSE
EventSource endpoint
```

这些属于 R4。

---

# 48. Regression Requirements

R3 完成后：

```text
R1 tests 82/82
R2 tests 113/113
所有 R3 tests green
```

外部 baseline：

```text
327 / 0
676 / 9 same cases
175 / 0
220 / 219 / 1 same case
```

13 protected files：

```text
13 / 13 SHA-256 match
```

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

# 49. R3 Definition of Done

## HTTP

- [ ] loopback-only server。
- [ ] Host fence。
- [ ] `/api/v1/health`。
- [ ] session list。
- [ ] session detail。
- [ ] message history。
- [ ] prompt submit。
- [ ] cancel。
- [ ] upload protocol resolved or explicitly 501。
- [ ] 404/405/413/415 distinction。
- [ ] standard error envelope。

## Domain integration

- [ ] HTTP consumes R2 domain services only。
- [ ] no HTTP → wire direct dependency。
- [ ] StatusService exists。
- [ ] control baseline wired。
- [ ] active follow lifecycle wired。
- [ ] cancel admission semantics preserved。
- [ ] waiting_input limitation preserved。

## Pagination

- [ ] session list bounded。
- [ ] cursor opaque。
- [ ] message page bounded。
- [ ] DSH source sequence not confused with Gateway sequence。

## Prompt

- [ ] default mode `steer` centralized in config。
- [ ] explicit `queue` supported。
- [ ] `client_message_id` preserved。
- [ ] 202 immediately。

## Security baseline

- [ ] no wildcard CORS。
- [ ] loopback only。
- [ ] Host validation。
- [ ] body limits。
- [ ] no secret in responses/errors。
- [ ] upload path traversal rejected。
- [ ] no `.credentials.yaml` read。

## Scope

- [ ] no phone WebSocket/SSE。
- [ ] no disk persistence/replay。
- [ ] no Bearer auth。
- [ ] no supervisor。
- [ ] no UI。
- [ ] no SSH/Tailscale changes。
- [ ] R4 not started。

## Regression

- [ ] R1 82/82。
- [ ] R2 113/113。
- [ ] R3 tests all pass。
- [ ] external baselines unchanged。
- [ ] protected hashes 13/13。
- [ ] U+FFFD scan clean。

---

# 50. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R3-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R2 baseline confirmation
3. Scope completed
4. Files created
5. Files modified
6. REST architecture
7. Server lifecycle
8. Bind / Host policy
9. API endpoint table
10. Request schemas
11. Response schemas
12. Error mapping
13. Session pagination
14. Message pagination
15. Prompt mode decision
16. StatusService design
17. Control/follow lifecycle
18. Upload wire audit
19. Upload API implementation
20. Security review
21. Test results
22. R1/R2 regression
23. External regression
24. Protected hash verification
25. Encoding/UTF-8 verification
26. Known limitations
27. Deferred R4/R5/R6/R7 work
28. R4 readiness
29. Exact stop statement
```

---

# 51. 报告必须逐项回答

1. HTTP server 实际绑定在哪里？
2. 是否能配置成 `0.0.0.0`？若传入会发生什么？
3. 是否检查 Host？
4. 是否发送 wildcard CORS？
5. health 如何区分 Gateway ready 与 DSH unavailable？
6. 是否泄漏 DSH_HOME、cookie、token、credentials？
7. `/sessions` 默认 limit/max limit 是什么？
8. cursor 是否 opaque？
9. session list 变化时 cursor 有什么限制？
10. message pagination 中的 sequence 是什么语义？
11. Gateway event sequence 是否被错误用于 history page？
12. POST messages 的默认 mode 是什么？
13. 为什么选它？
14. 客户端能否显式选择 `queue`？
15. `client_message_id` 是否保持为 DSH requestId？
16. HTTP submit 是否等待模型完成？
17. cancel 202 是否被错误当成 cancelled？
18. 什么时候状态才变成 cancelled？
19. StatusService 是否使用 control baseline？
20. waiting_input 在重启后能否可靠恢复？
21. 是否创建 phone-facing WebSocket/SSE？
22. upload wire 是否被真实审计？
23. upload 是否直接写 `.dsh/attachments`？
24. upload 是否拒绝 traversal？
25. 是否有 body size limits？
26. 是否读取 `.credentials.yaml`？
27. 是否写任何 durable persistence？
28. 是否使用 PowerShell `Set-Content/Out-File/Add-Content` 修改源码？
29. UTF-8/U+FFFD scan 结果？
30. R1 82 tests 是否全绿？
31. R2 113 tests 是否全绿？
32. R3 新测试数量？
33. external regression 是否出现新 fail？
34. protected hashes 是否 13/13？
35. 是否进入 R4？

---

# 52. Stop Gate

R3 完成后输出：

```text
R3 COMPLETE — STOPPING HERE.
```

不得创建：

```text
src/remote/ws/*
src/remote/replay.mjs
src/remote/persistence.mjs
src/remote/auth.mjs   # phone Bearer
public/debug/remote/*
scripts/dsh-start.ps1
scripts/dsh-stop.ps1
scripts/dsh-restart.ps1
scripts/ssh-enable.ps1
```

不得：

```text
enable sshd
install Tailscale
open Windows Firewall port
modify DSH profile
modify .credentials.yaml
capture real DSH token
```

等待人工验收。

---

# 53. 给 DSH 的执行指令

现在执行：

```text
Phase R3 — Loopback REST API & Status Service
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R2-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r2-status-evidence.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R1-REPORT.md
D:\DSH-testing\dsh-remote-gateway\README.md
```

执行顺序：

1. 确认 R1 82 + R2 113 baseline。
2. 先实现 StatusService。
3. 只读审计 upload wire，写 `docs/r3-upload-evidence.md`。
4. 定义 `docs/r3-rest-contract.md`。
5. 实现 loopback HTTP server。
6. 实现 routes/validation/errors/pagination。
7. 实现 `/health`。
8. 实现 sessions/history/messages/cancel。
9. 若 upload wire 已验证则实现 upload；否则 fail-visible 501。
10. 完成 R3 tests。
11. 重跑 R1/R2。
12. 重跑四组 external baseline。
13. 验证 protected hashes。
14. 扫描 U+FFFD / UTF-8。
15. 生成 `PHASE-R3-REPORT.md`。
16. STOP。
17. 不进入 R4。

若发现 R2 domain/state assumption 与真实 wire 不兼容：

```text
STOP IMPLEMENTATION
R3_DOMAIN_ASSUMPTION_INVALIDATED
```

若 upload wire 无法可靠确认：

```text
R3_UPLOAD_WIRE_UNRESOLVED
```

不得猜测或绕过。
