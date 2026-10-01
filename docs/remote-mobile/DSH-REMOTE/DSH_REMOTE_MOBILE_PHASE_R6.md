# Phase R6 — Phone Authentication & Security Hardening

> 前置阶段：
>
> - Phase R5 — Durable Event Journal, Recovery & Cross-Restart Replay
> - Phase R5A — Compliance Remediation & Acceptance Gate
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段目标：
>
> 在 R3 REST + R4 WebSocket + R5 durable persistence 基础上，为未来手机端建立 **真实的认证边界与生产级入口硬化**：
>
> ```text
> REST Bearer authentication
> browser-compatible one-time WebSocket ticket
> Origin/CORS production policy
> auth rate limiting
> WebSocket connection limits
> upload request quotas
> credential-safe logging/redaction
> auth health axis
> ```
>
> **R6 只实现认证机制和安全策略。**
>
> **R6 不生成或安装真实 production credential。**
>
> **R7 才负责 supervisor、PID/log files、真实 Phone token bootstrap、DSH launch-token/cookie bootstrap、Windows ACL hardening 和第一次 production start。**
>
> 完成 R6 后生成 `PHASE-R6-REPORT.md` 并停止，不得自动进入 R7。

---

# 0. 前置验收状态

R5 历史记录必须保留：

```text
R5 historical phase:
  implementation passed
  process gate violated
```

R5A 已通过：

```text
R5A COMPLETE — COMPLIANCE REMEDIATION PASSED.
```

组合结论：

```text
R5 implementation accepted for progression to R6,
with the original R5 violations retained in the audit record.
```

当前技术 baseline：

```text
R1:   82 / 82
R2:  113 / 113
R3:  161 / 161
R4:  132 / 132
R5:  155 / 155
R5A:  12 / 12

Full:
655 / 655
```

外部：

```text
planner declared: 327 / 0
planner full:     676 / 9 same cases
codex declared:   175 / 0
codex full:       220 / 219 / 1 same case

protected:
13 / 13
```

R6 开始前必须先运行：

```text
npm run compliance:r5a
```

必须 PASS。

---

# 1. R6 核心安全模型

手机未来拥有：

```text
one long-lived opaque Phone Bearer credential
```

用途：

```text
REST Authorization
```

但浏览器 WebSocket 无法任意设置：

```text
Authorization: Bearer ...
```

而 R4 已经正确禁止：

```text
?token=
?access_token=
?bearer=
```

因此 R6 使用：

```text
REST Bearer
    ↓
POST /api/v1/auth/ws-ticket
    ↓
one-time short-lived WS ticket
    ↓
WS /api/v1/events?...&ticket=<one-time-ticket>
```

**长期 Phone Bearer 永远不进入 URL。**

---

# 2. Trust Boundary

```text
Phone browser / native client
        │
        │ Authorization: Bearer <PHONE_TOKEN>
        ▼
R6 AuthService
        │
        ├── REST authorization
        └── mint short-lived WS ticket
                     │
                     ▼
             R4 upgrade seam
                     │
                     ▼
               WebSocket session
```

与 DSH auth 完全独立：

```text
Phone Bearer
≠
DSH launch token
≠
DSH auth cookie
≠
DeepSeek API credential
```

禁止任何 mapping：

```text
phone token → DSH token
```

---

# 3. Credential Ownership Boundary

R6 负责：

```text
token validation
constant-time verification
ticket mint/consume
auth policy
rate limits
redaction
```

R6 不负责：

```text
generating production Phone token
writing Phone token to disk
showing pairing code
printing credential
setting Windows ACL
reading token from .credentials.yaml
launching DSH
capturing DSH launch token
```

R7 以后负责：

```text
credential generation / storage / bootstrap
```

R6 tests 只使用：

```text
synthetic in-memory secrets
```

---

# 4. Recommended Files

```text
src/remote/auth/
  auth-service.mjs
  bearer.mjs
  ws-ticket.mjs
  cors.mjs
  origin-policy.mjs
  rate-limit.mjs
  connection-limit.mjs
  upload-quota.mjs
  config.mjs
  errors.mjs
  redact-auth.mjs

tests/remote/
  auth-bearer.test.mjs
  auth-rest.test.mjs
  auth-health.test.mjs
  auth-ticket.test.mjs
  auth-ws-ticket.test.mjs
  auth-ticket-race.test.mjs
  auth-origin-cors.test.mjs
  auth-rate-limit.test.mjs
  auth-connection-limit.test.mjs
  auth-upload-quota.test.mjs
  auth-redaction.test.mjs
  auth-persistence-boundary.test.mjs
  auth-integration.test.mjs

scripts/
  r6-fixture-auth.mjs

docs/
  r6-auth-contract.md
  r6-security-model.md
```

实际结构可调整，但职责必须清晰。

---

# 5. AuthService Injection

Server factory 增加明确参数：

```js
createRemoteHttpServer({
  ...,
  auth
})
```

R6 production-shaped server：

```text
auth REQUIRED
```

fixture 可显式：

```text
auth: null
```

但：

```text
auth: null
```

只允许 synthetic/fixture mode。

不得恢复类似 R5 的：

```text
auth omitted → silently disabled
```

必须：

```text
explicit auth decision
```

---

# 6. Auth Modes

定义：

```text
required
disabled-fixture
```

不要：

```text
optional
auto
best-effort
```

Production-shaped server：

```text
required
```

Synthetic fixture：

```text
disabled-fixture
```

如果没有显式决定：

```text
TypeError
```

这沿用 R5A 的“显式安全决策”原则。

---

# 7. Long-Lived Bearer Token Shape

Phone Bearer 是：

```text
opaque random secret
```

推荐生产生成：

```text
32 random bytes
base64url
```

典型约：

```text
43 chars
```

R6 不生成 production token，但 validator 应要求最低强度。

建议：

```text
decoded entropy >= 256 bits
```

为了避免过度约束编码形式，可允许：

```text
base64url 32+ bytes
hex 32+ bytes
```

或者定义单一标准：

```text
base64url 32 bytes exactly
```

推荐单一标准，减少 ambiguity：

```text
PHONE_TOKEN = 32 random bytes, base64url without padding
```

R7 按此生成。

---

# 8. Bearer Header

REST：

```http
Authorization: Bearer <PHONE_TOKEN>
```

解析必须：

- exactly one Authorization header。
- scheme ASCII-case-insensitive `Bearer`。
- exactly one credential。
- reject empty。
- reject whitespace/control chars。
- reject comma-separated multiple credentials。
- max header length bounded。

错误：

```text
401 AUTH_REQUIRED
401 AUTH_INVALID
```

响应必须带：

```http
WWW-Authenticate: Bearer realm="dsh-remote"
```

错误 body 不回显 token。

---

# 9. Constant-Time Verification

不要：

```js
supplied === expected
```

推荐：

```text
hash expected token once
hash supplied token
timingSafeEqual(fixed-length digest)
```

例如：

```text
SHA-256 digest
crypto.timingSafeEqual
```

AuthService 初始化后：

尽量不长期保存 raw token string。

如果 constructor 接 Buffer：

```text
hash then zero caller-independent copy where practical
```

JavaScript 不能保证 secret 从内存彻底清除，报告需诚实说明。

---

# 10. Principal

R6 v1 只有：

```text
one phone principal
```

公开 principal id：

```text
phone
```

不要把：

```text
token hash
token prefix
token fingerprint
```

暴露给手机。

内部审计若需要 stable id：

使用：

```text
phone
```

即可。

多设备 token：

```text
future extension
```

不属于 R6。

---

# 11. Public Health vs Authenticated Health

当前 `/api/v1/health` 包含：

```text
gateway
DSH
persistence
```

R6 后：

### 未认证

```http
GET /api/v1/health
```

允许返回最小健康信息：

```json
{
  "api_version": 1,
  "data": {
    "gateway": "ready",
    "auth": {
      "required": true
    }
  }
}
```

不得返回：

```text
DSH version/status detail
persistence format/reason detail
internal failure code
```

### 已认证

同一 endpoint + valid Bearer：

返回完整既有 health：

```text
gateway
dsh
persistence
auth
```

这样：

```text
load balancer / human can see process alive
```

但敏感 operational detail 需要 auth。

---

# 12. Protected REST Routes

除 minimal health 外，以下全部需要 Bearer：

```text
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
GET  /api/v1/sessions/:id/messages

POST /api/v1/sessions/:id/messages
POST /api/v1/sessions/:id/cancel
POST /api/v1/sessions/:id/uploads

POST /api/v1/auth/ws-ticket
```

未来 R8 UI static assets：

不在 R6。

---

# 13. Auth Must Precede Domain Lookup

对 protected route：

顺序：

```text
Host / Origin policy
↓
auth
↓
rate limit
↓
route-specific validation/domain lookup
```

不要：

```text
404 session-not-found before auth
```

否则 unauthenticated caller 可以枚举 session existence。

测试：

同一个不存在 session：

```text
no auth → 401
valid auth → 404
```

---

# 14. WebSocket Ticket Endpoint

新增：

```text
POST /api/v1/auth/ws-ticket
```

要求：

```text
Bearer required
Content-Type: application/json
```

Request：

```json
{
  "session_id": "session-..."
}
```

可选：

```json
{
  "session_id": "session-...",
  "origin": "..."
}
```

不推荐让客户端自由声明 origin。

优先从 HTTP request 的实际：

```text
Origin
```

决定绑定。

---

# 15. WS Ticket Response

成功：

```text
201 Created
```

```json
{
  "api_version": 1,
  "data": {
    "ticket": "<opaque one-time ticket>",
    "expires_at": "2026-09-19T...",
    "expires_in_seconds": 30,
    "session_id": "session-..."
  }
}
```

Response headers：

```text
Cache-Control: no-store
Pragma: no-cache
```

Ticket 只返回一次。

---

# 16. Ticket Entropy

Ticket：

```text
32 random bytes
base64url no padding
```

使用：

```js
crypto.randomBytes(32)
```

不是：

```text
UUID
timestamp
counter
signed session id
```

ticket 本身拥有足够 entropy。

---

# 17. Server-Side Ticket Storage

不要把 ticket plaintext 存在 Map。

存：

```text
SHA-256(ticket)
```

record：

```js
{
  digest,
  principal_id: 'phone',
  session_id,
  issued_at,
  expires_at,
  origin_binding,
  consumed: false
}
```

如果用 Map：

key 使用 digest hex/base64。

---

# 18. Ticket Lifetime

默认：

```text
DSH_REMOTE_WS_TICKET_TTL_SECONDS=30
```

允许范围：

```text
10..120
```

过期：

```text
WS_TICKET_EXPIRED
```

Ticket 不续期。

手机重新：

```text
POST /auth/ws-ticket
```

---

# 19. Ticket One-Time Semantics

Ticket：

```text
exactly one successful upgrade attempt
```

验证顺序：

```text
Host
Origin
path
subprotocol
query grammar
session id
ticket digest lookup
expiry
session binding
origin binding
↓
atomic consume
↓
101
```

consume 必须在：

```text
handleUpgrade
```

前完成且原子。

如果 handleUpgrade 随后失败：

ticket 可视为 consumed。

安全优先于 convenience。

---

# 20. Ticket Replay

第二次使用：

```text
401 / 403 pre-101
WS_TICKET_INVALID
```

不要区分：

```text
unknown
already used
random
```

给外部客户端的 message 保持 generic。

内部测试可以区分 counter。

---

# 21. Ticket Session Binding

Ticket mint：

```text
session_id = A
```

只允许：

```text
WS ?session_id=A
```

尝试：

```text
?session_id=B
```

必须失败 pre-101。

Ticket 不能：

```text
在任意 session 重用
```

---

# 22. Ticket Origin Binding

如果 ticket issuance request 有：

```text
Origin
```

则 ticket 绑定该 normalized exact origin。

WS Upgrade 必须带：

```text
same Origin
```

不同：

```text
WS_TICKET_INVALID
```

如果 issuance 是 native request、无 Origin：

ticket 绑定：

```text
origin = none
```

只允许 Upgrade 也：

```text
Origin absent
```

这样被窃取的 browser-issued ticket 无法从另一个 website 使用。

---

# 23. Ticket Is Allowed in URL

R4 禁止：

```text
token
access_token
bearer
```

R6 新增唯一 credential query：

```text
ticket
```

原因：

```text
browser WebSocket limitation
+
ticket one-time
+
30 s TTL
+
session-bound
+
origin-bound
```

R6 contract 必须明确：

```text
ticket is not the Phone Bearer
```

---

# 24. URL / Error Redaction

任何日志/debug/error：

原始 request URL：

```text
/api/v1/events?...&ticket=SECRET
```

不得原样记录。

统一 redaction：

```text
ticket=<redacted>
token=<redacted>
access_token=<redacted>
bearer=<redacted>
```

即使 R4 本身拒绝后三者，也要 redact。

测试必须构造：

```text
ticket=KNOWN_SECRET
```

然后扫描：

```text
response
error
console capture
structured diagnostics
```

全部无 secret。

---

# 25. Ticket Is Ephemeral State

Ticket store：

```text
memory only
```

不得写：

```text
R5 journal
snapshot
dsh-cursors
disk log
```

Gateway restart：

```text
all outstanding tickets invalid
```

这是正确语义。

---

# 26. Ticket Cleanup

至少：

```text
lazy cleanup on mint/consume
```

并可：

```text
periodic cleanup
```

默认 outstanding limit：

```text
DSH_REMOTE_WS_MAX_OUTSTANDING_TICKETS=32
```

超过：

```text
429 AUTH_TICKET_LIMIT
```

防止内存滥用。

---

# 27. Browser Origin Policy

R4 当前 WebSocket Origin policy：

```text
loopback same-port
```

R6 抽象为一个共享：

```text
OriginPolicy
```

供：

```text
REST
CORS
WS
ticket binding
```

共同使用。

不得维护四份不同规则。

---

# 28. Allowed Origins

默认继续允许：

```text
http://127.0.0.1:<port>
http://localhost:<port>
http://[::1]:<port>
```

用于：

```text
same-origin local UI
SSH local forward
```

允许配置：

```text
DSH_REMOTE_ALLOWED_ORIGINS
```

格式：

```text
comma-separated exact origins
```

例如：

```text
https://phone-ui.example
```

规则：

- absolute `http:` or `https:` only。
- no path/query/fragment。
- no wildcard。
- no `null`。
- no `file:`。
- no browser-extension scheme。
- normalize default ports。
- duplicates removed。

**R6 不改变 bind policy。**

配置外部 Origin 并不会让 server 监听 LAN。

---

# 29. REST Origin Rules

Native clients：

```text
Origin absent → allowed
```

Browser：

```text
Origin present → must be allowed
```

即使 Bearer 正确：

```text
disallowed Origin → 403 before route
```

这样被恶意页面拿到 token 的风险进一步降低。

---

# 30. CORS Policy

R3 没有 CORS。

R6 支持精确 CORS：

仅当 request Origin 在 allowlist：

```text
Access-Control-Allow-Origin: <exact origin>
Vary: Origin
```

绝不：

```text
*
```

由于 auth 是 Authorization header：

```text
Access-Control-Allow-Credentials
```

不需要，默认不发送。

---

# 31. Preflight

允许：

```text
OPTIONS protected-route
```

仅在：

```text
Origin allowed
Access-Control-Request-Method is valid
requested headers subset allowed
```

允许 request headers：

```text
Authorization
Content-Type
X-Request-Id
```

必要时：

```text
Sec-* headers 由浏览器/WS 管理，不属于 CORS preflight
```

返回：

```text
204
```

包括：

```text
Access-Control-Allow-Origin
Access-Control-Allow-Methods
Access-Control-Allow-Headers
Access-Control-Max-Age
Vary: Origin
```

disallowed：

```text
403
```

---

# 32. Preflight Is Not Authentication

OPTIONS：

```text
不要求 Bearer
```

因为浏览器发送真实 request 前需要知道是否允许 Authorization header。

但：

```text
allowed Origin only
exact method/header validation
no protected resource body
```

---

# 33. Host Fence Remains

R6 **不得**因为有 Bearer auth 就放宽：

```text
Host fence
loopback bind
```

仍：

```text
127.0.0.1
localhost
::1
```

R9 再决定 tunnel topology。

Defense in depth：

```text
loopback bind
+
Host
+
Origin
+
Bearer
```

---

# 34. Auth Rate Limiting

R6 增加 in-memory token bucket / sliding window。

不要依赖 remote IP 作为 principal：

未来 SSH/Tailscale tunnel 可能让所有连接看起来：

```text
127.0.0.1
```

authenticated limit key：

```text
principal_id = phone
```

unauthenticated abuse：

```text
remote socket identity + global bucket
```

---

# 35. Default Rate Limits

建议 Gateway defaults：

```text
Authenticated reads:
  120 requests / 60 s

Authenticated mutations:
  30 requests / 60 s

WS ticket mint:
  20 / 60 s

Failed auth:
  10 / 60 s per remote identity
  100 / 60 s global

Upload starts:
  10 / 60 s
```

这些不是 DSH limits。

全部 configurable + bounded。

---

# 36. Rate-Limit Response

HTTP：

```text
429 TOO_MANY_REQUESTS
```

headers：

```text
Retry-After
```

error：

```text
RATE_LIMITED
```

不得回显：

```text
token
token fingerprint
```

---

# 37. Failed-Auth Oracle

Missing/invalid token：

可以内部计数不同 reason。

外部建议统一：

```text
401 AUTH_INVALID
```

避免提供：

```text
"correct prefix"
"wrong length after decode"
```

等 oracle。

格式问题也用 generic response。

---

# 38. WebSocket Connection Limit

每 principal：

```text
DSH_REMOTE_WS_MAX_CONNECTIONS_PER_PRINCIPAL=4
```

超过：

pre-101：

```text
429
WS_CONNECTION_LIMIT
```

计数：

```text
成功 upgrade 后 +1
close/terminate 后 -1
```

必须无 leak。

Ticket consume 和 connection limit 的顺序需防 race：

推荐：

```text
reserve slot
consume ticket
upgrade
```

upgrade 失败：

```text
release slot
ticket remains consumed
```

---

# 39. Ticket Mint Does Not Reserve Connection

mint ticket：

```text
不占 active connection slot
```

否则大量未使用 ticket 会耗尽连接数。

outstanding ticket 有独立 cap。

---

# 40. WebSocket Backlog Unchanged

R4：

```text
256 frames
1 MiB
```

保持。

R6 不修改 event delivery/backpressure。

auth 只发生于：

```text
handshake
```

连接建立后：

```text
R4 protocol unchanged
```

---

# 41. Upload Quotas

R3 已有：

```text
25 MiB per upload
```

R6 增加：

```text
upload starts / minute
aggregate accepted bytes / window
concurrent uploads
```

建议：

```text
DSH_REMOTE_UPLOAD_MAX_CONCURRENT=2
DSH_REMOTE_UPLOAD_BYTES_PER_10_MIN=104857600
```

即：

```text
100 MiB / 10 min
```

Gateway defaults。

---

# 42. Upload Quota Accounting

必须：

```text
streaming accounting
```

不能只信：

```text
Content-Length
```

existing 25 MiB single-upload limit 继续。

如果 aggregate quota 中途超限：

```text
destroy request stream
429 UPLOAD_QUOTA_EXCEEDED
```

不要把已超 quota 的 bytes继续转给 DSH。

---

# 43. No Content Scanner Requirement

R6 不强制实现 antivirus/content scanning，因为当前环境没有已审计的安全 scanner。

继续依赖：

```text
size
filename
MIME syntax
DSH byte inspection
rate/quota
```

报告明确：

```text
malware scanning not implemented
```

不要假装有扫描能力。

---

# 44. Auth and Persistence Boundary

Phone Bearer 和 WS ticket：

不得进入：

```text
Gateway Event.data
R5 journal
session snapshot
DSH cursor file
reconciliation record
```

新增 source + runtime tests：

- journal files scan 不包含 synthetic Bearer。
- snapshots scan 不包含 ticket。
- auth objects不可传给 `EventsService.emit()`。
- `inspectForSecrets` 保持阻断 internal credential-shaped fields。

---

# 45. User Text Preservation

继续 R5 原则：

用户说：

```text
"my token budget is 1000"
```

这是普通文本。

不得因为 R6 有 auth token 就：

```text
rewrite/redact user message content
```

redaction 只作用于：

```text
headers
query credential fields
structured auth fields
logs/errors
```

---

# 46. Health Auth Axis

Authenticated health 增加：

```json
{
  "auth": {
    "status": "ready",
    "mode": "bearer+ws-ticket",
    "ticket_ttl_seconds": 30
  }
}
```

不得：

```text
token hash
ticket count exact if sensitive
credential source path
```

可以输出：

```text
active_ws_connections
```

但不是必要。

---

# 47. No Credential Source Disclosure

R6 AuthService 可以知道 synthetic token。

但 health/error/docs runtime response不得输出：

```text
env var name used
file path
token fingerprint
length
prefix
generation time
```

R7 运维日志可记录：

```text
credential loaded
```

但不记录值。

---

# 48. Auth Config

建议：

```text
DSH_REMOTE_AUTH_MODE=required
DSH_REMOTE_ALLOWED_ORIGINS=...
DSH_REMOTE_WS_TICKET_TTL_SECONDS=30
...
```

**但 R6 product code 不应自行读取 production Phone token env var。**

Phone token 通过：

```text
AuthService constructor injection
```

进入。

R7：

```text
load/generate credential
→ construct AuthService
```

这样 credential bootstrap 边界清晰。

---

# 49. Fixture Auth

创建：

```text
scripts/r6-fixture-auth.mjs
```

仅 synthetic：

```text
random/synthetic token generated in fixture process
```

允许打印：

```text
SYNTHETIC PHONE TOKEN: ...
```

前提 banner 非常明确：

```text
FIXTURE ONLY
NOT PRODUCTION
```

更安全做法：

脚本自己作为 client，不需要输出完整 token。

优先：

```text
不打印 token
```

---

# 50. Fixture Scenario

```text
1. unauthenticated GET /sessions → 401
2. authenticated GET /sessions → 200
3. POST /auth/ws-ticket → one-time ticket
4. WS connect with ticket → 101
5. emit event → received
6. reuse same ticket → rejected
7. mint second ticket
8. wrong session → rejected
9. expired ticket → rejected
10. origin mismatch → rejected
```

全部 synthetic。

---

# 51. Authentication Errors

集中 vocabulary：

```text
AUTH_REQUIRED
AUTH_INVALID
AUTH_CONFIG_INVALID

WS_TICKET_INVALID
WS_TICKET_EXPIRED
AUTH_TICKET_LIMIT

ORIGIN_NOT_ALLOWED
CORS_PREFLIGHT_REJECTED

RATE_LIMITED
WS_CONNECTION_LIMIT
UPLOAD_QUOTA_EXCEEDED
```

不要把：

```text
"ticket already used"
"ticket hash not found"
```

暴露成细粒度外部 code。

统一：

```text
WS_TICKET_INVALID
```

---

# 52. HTTP Status Mapping

建议：

```text
AUTH_REQUIRED / AUTH_INVALID       → 401
ORIGIN_NOT_ALLOWED                 → 403
WS_TICKET_INVALID / EXPIRED        → 401 or 403, choose one consistently
RATE_LIMITED                       → 429
AUTH_TICKET_LIMIT                  → 429
WS_CONNECTION_LIMIT                → 429
UPLOAD_QUOTA_EXCEEDED              → 429
AUTH_CONFIG_INVALID                → startup fail
```

推荐 ticket：

```text
401
```

表示 credential invalid。

---

# 53. Startup Auth Validation

Production-shaped server 在 bind 前验证：

```text
AuthService exists
token digest initialized
origin config valid
rate limits valid
ticket TTL valid
connection limit valid
upload quota valid
```

错误：

```text
AUTH_CONFIG_INVALID
```

server：

```text
does not bind
```

与 R5 persistence startup fail-closed 一致。

---

# 54. Startup Ordering

R6 后建议：

```text
R5A compliance precondition (operator/test)
↓
validate persistence config
↓
persistence recovery
↓
validate auth config/service
↓
start status service
↓
bind 9445
```

Auth 无效时：

```text
never expose unauthenticated protected routes
```

---

# 55. CORS and Auth Ordering

普通 browser request：

```text
Host
↓
Origin
↓
CORS decision
↓
Bearer
↓
rate limit
↓
route
```

OPTIONS：

```text
Host
↓
Origin
↓
preflight validation
↓
204
```

不进入 domain。

---

# 56. WebSocket Ordering

Upgrade：

```text
Host
↓
Origin
↓
path/protocol/query validation
↓
ticket
↓
connection limit reserve
↓
ticket atomic consume
↓
handleUpgrade
```

如果：

```text
connection limit unavailable
```

不要 consume ticket。

如果：

```text
ticket invalid
```

不要 reserve slot。

实际实现可以：

```text
validate ticket
reserve slot
consume ticket
```

但必须通过一个 atomic AuthService method 避免：

```text
two simultaneous upgrades use same ticket
```

---

# 57. Ticket Race

必须有并发测试：

```text
two upgrades
same ticket
same millisecond
```

期望：

```text
exactly one 101
other rejected
```

不能两个都通过。

在 Node 单线程里：

```text
lookup + delete
```

无 await 可原子完成。

---

# 58. Authorization Header Never Forwarded

Gateway Bearer：

不得传给：

```text
DshAdapter
DSH Web RPC
uploadRaw
wire client
```

测试：

fake adapter 捕获所有请求：

```text
Authorization absent
Phone token absent
ticket absent
```

---

# 59. DSH Credential Separation

反方向同样：

DSH：

```text
dsh-auth cookie
launch token
```

不得：

```text
be accepted as Phone Bearer
be returned to phone
be used as ticket
```

synthetic test：

```text
Bearer dsh-auth-abcdef
→ 401
```

除非恰好等于 fixture Phone token，这不应发生。

---

# 60. Security Headers

所有 REST responses 建议：

```text
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

未来 R8 UI 再决定 CSP。

不要现在写：

```text
unsafe-inline CSP
```

没有 UI。

Ticket endpoint 额外：

```text
Pragma: no-cache
```

---

# 61. TLS Boundary

R6 不启 TLS listener。

原因：

```text
9445 remains loopback
R9 provides transport/tunnel topology
```

R6 docs 必须写：

```text
Bearer must never be sent over an untrusted cleartext network.
Current HTTP is only acceptable because the server remains loopback-only and remote access must use a secure tunnel.
```

不要放宽 bind 后继续 HTTP。

---

# 62. Logs

R7 才落 disk logs。

R6 当前 console/diagnostic：

必须 redact：

```text
Authorization
Bearer values
ticket query
ticket response if logged
Cookie
dsh-auth
```

新增：

```text
redactRequestUrl()
redactHeaders()
```

或等价集中函数。

---

# 63. Rate-Limit State Persistence

R6 rate limit counters：

```text
memory only
```

Gateway restart：

```text
limits reset
```

可接受。

不要写入 R5 durable journal。

---

# 64. Ticket State Persistence

同样：

```text
memory only
```

restart 后：

```text
all tickets invalid
```

R6 docs 明确。

---

# 65. Time Handling

TTL/rate tests 必须用：

```text
injectable clock
```

禁止真实 sleep 30 秒。

Production：

```text
Date.now()
```

或现有 clock abstraction。

---

# 66. Clock Rollback

Ticket expiry 基于：

```text
monotonic-ish injected elapsed model
```

Node wall clock可能调整。

简单 R6 实现可用：

```text
Date.now()
```

但必须：

- expiry comparison fail closed。
- absurd future/past ticket 不可 client-controlled。
- ticket `issued_at` 只 server生成。

不要求复杂 monotonic persistence，因为 tickets process-local。

---

# 67. R5A Compliance Gate Is Standing Precondition

R6 开始前：

```text
npm run compliance:r5a
```

R6 完成后：

```text
npm run compliance:r5a
```

都必须 PASS。

R6 若：

```text
touch real DSH_HOME
forbidden cmdlet invocation
BOM/UTF-8 issue
```

则：

```text
R6 PROCESS FAILURE
```

不得继续报告成功。

---

# 68. Source Editing Rules

继承 R5A：

不得用：

```powershell
Set-Content
Out-File
Add-Content
```

修改项目源码/测试/docs/config。

只用：

```text
file-edit tooling
Node fs explicit UTF-8
```

违规：

```text
R6_PROCESS_VIOLATION
STOP
```

---

# 69. No Real DSH_HOME

R6 automated tests：

```text
real D:\DSH-work-test\.dsh\remote
```

必须始终：

```text
NOT EXISTS
```

所有 persistence tests：

temp root。

R6 不负责 R7 production start。

---

# 70. No `.credentials.yaml`

继续：

```text
never open
never parse
never hash content
never copy
```

R6 Phone Auth 与 DSH credentials 无关。

---

# 71. No Production Phone Token File

R6 不创建：

```text
phone-token
auth.json
credentials.json
.secret
.env
```

真实 credential store 属于 R7。

tests 可在：

```text
memory
temp directory only if absolutely necessary
```

但推荐纯内存。

---

# 72. No New Listener

继续：

```text
REST + WS
one loopback listener
9445
```

R6 不新增：

```text
9446 auth port
callback listener
OAuth redirect server
```

---

# 73. No OAuth

R6 不引入：

```text
Google login
OpenAI login
OAuth
OIDC
JWT issuer
```

本项目需求是：

```text
single-user private phone client
```

opaque bearer 更简单、攻击面更小。

---

# 74. No Cookie Auth

不要用 browser cookie 作为 Phone auth：

原因：

- CSRF/ambient credential complexity。
- tunnel hostname变化。
- WS ticket flow已经解决 browser WS header限制。

REST：

```text
explicit Authorization header
```

---

# 75. R6 Tests

至少新增：

```text
auth-bearer.test.mjs
auth-rest.test.mjs
auth-health.test.mjs
auth-ticket.test.mjs
auth-ws-ticket.test.mjs
auth-ticket-race.test.mjs
auth-origin-cors.test.mjs
auth-rate-limit.test.mjs
auth-connection-limit.test.mjs
auth-upload-quota.test.mjs
auth-redaction.test.mjs
auth-persistence-boundary.test.mjs
auth-integration.test.mjs
```

---

# 76. Bearer Tests

覆盖：

```text
valid bearer
missing header
wrong scheme
wrong token
empty token
multiple Authorization
oversized header
control chars
constant-time digest path
generic failure body
WWW-Authenticate
```

不要试图通过 timing benchmark 证明 constant-time。

测试：

```text
source/API path uses timingSafeEqual fixed digests
```

---

# 77. REST Auth Tests

对每个 protected route：

```text
no token → 401
bad token → 401
good token → original behavior
```

特别：

```text
unknown session without auth → 401
unknown session with auth → 404
```

防 enumeration。

---

# 78. Health Tests

```text
unauthenticated → minimal
authenticated → full DSH/persistence/auth
no token detail
no credential source
no path leak
```

---

# 79. Ticket Tests

覆盖：

```text
mint
entropy/shape
TTL
expiry
one-time
unknown
wrong session
wrong origin
native no-origin binding
max outstanding
cleanup
not persisted
```

---

# 80. WS Ticket Tests

真实 socket：

```text
no ticket → reject
long-lived bearer in query → reject
valid ticket → 101
reuse → reject
expired → reject
wrong session → reject
wrong origin → reject
```

确认：

```text
dsh-remote-v1 unchanged
```

---

# 81. Ticket Race Test

两个并发 upgrade：

```text
same valid ticket
```

必须：

```text
success count = 1
failure count = 1
```

重复多轮。

---

# 82. Origin/CORS Tests

REST：

```text
allowed same-origin
allowed configured exact origin
hostile origin
null origin
wildcard config rejected
path-bearing origin rejected
OPTIONS 204 allowed
OPTIONS hostile → 403
Authorization allowed header
unlisted header → reject
Vary: Origin
no wildcard
no credentials
```

WS：

复用同一 policy。

---

# 83. Rate Limit Tests

injectable clock：

```text
read bucket
mutation bucket
ticket bucket
failed-auth bucket
global failed-auth bucket
Retry-After
window reset
principal isolation seam
no token leak
```

R6 v1只有一个 real principal，但实现不要把 token本身作为 Map key。

---

# 84. Connection Limit Tests

```text
1..N connections succeed
N+1 → 429 pre-101
close one
new one succeeds
abrupt terminate releases slot
failed upgrade releases reservation
ticket mint does not count
ticket race does not double count
```

---

# 85. Upload Quota Tests

```text
concurrent <= limit
concurrent > limit
aggregate bytes exact boundary
without Content-Length
mid-stream exceed
request stream destroyed
no DSH forwarding after quota
window reset
single-upload 25 MiB still enforced
```

---

# 86. Redaction Tests

synthetic values：

```text
PHONE_BEARER_SECRET_X
WS_TICKET_SECRET_Y
DSH_COOKIE_SECRET_Z
```

扫描：

```text
HTTP errors
WS errors
diagnostics
console capture
redacted URLs
redacted headers
journal
snapshot
cursor file
```

必须：

```text
none appear
```

用户消息正文中相同文本：

```text
must remain unchanged
```

---

# 87. Persistence Boundary Tests

使用 temp root：

1. authenticated prompt。
2. event journal generated。
3. scan all state files。

不得出现：

```text
Phone bearer
WS ticket
Authorization header
Origin auth artefact
```

但：

```text
actual user content
```

必须仍存在。

---

# 88. Integration Scenario

```text
GET /health no auth
→ minimal 200

GET /sessions no auth
→ 401

GET /sessions valid bearer
→ 200

POST /auth/ws-ticket valid bearer + session A
→ 201 ticket T

WS /events session A ticket T
→ 101
→ hello
→ live/replay events

reuse T
→ reject

mint T2
use T2 for session B
→ reject

mint T3 from Origin O1
use from Origin O2
→ reject

POST message valid bearer
→ 202
WS receives event

rate limit deliberately exceeded
→ 429

all persistence files scanned
→ no auth material
```

---

# 89. Restart Semantics

Gateway restart：

```text
Phone Bearer:
R7 will reload same long-lived credential in production

WS tickets:
all invalidated

rate limits:
reset

journal:
retained from R5
```

R6 fixture restart：

inject same synthetic Bearer to new AuthService。

---

# 90. R6 Documentation

创建：

```text
docs/r6-auth-contract.md
docs/r6-security-model.md
```

Auth contract：

```text
REST Authorization syntax
401 behavior
health public/authenticated shape
ticket endpoint
ticket TTL
ticket single-use
WS URL
origin binding
rate-limit codes
```

Security model：

```text
trust boundaries
Phone token vs DSH credential
why token not in URL
why ticket can be in URL
Origin / Host / bind defense-in-depth
TLS/tunnel boundary
persistence boundary
known limitations
R7 credential bootstrap seam
```

---

# 91. R6 Known Limitations Must Include

至少：

```text
1. real production Phone token not generated until R7
2. no TLS listener; secure remote transport belongs to R9
3. server still loopback-only
4. rate limits reset on restart
5. WS tickets reset on restart
6. one Phone principal only
7. no malware scanner
8. no real authenticated DSH smoke until R7
9. Windows ACL hardening remains R7
```

---

# 92. R6 Regression Requirements

完成后：

```text
R1:   82 / 82
R2:  113 / 113
R3:  161 / 161
R4:  132 / 132
R5:  155 / 155
R5A:  12 / 12
R6: new tests all green
```

full suite：

```text
all green
```

至少：

```text
3 consecutive clean runs
```

每轮：

```text
R5A compliance PASS
real DSH_HOME\remote absent
```

---

# 93. External Regression

保持：

```text
327 / 0
676 / 9 same cases
175 / 0
220 / 219 / 1 same case
```

---

# 94. Protected Hashes

```text
13 / 13
```

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

# 95. Encoding / Process Gate

必须：

```text
BOM = 0
U+FFFD = 0
invalid UTF-8 = 0
```

以及：

```text
Set-Content source edit = 0
Out-File source edit = 0
Add-Content source edit = 0
```

若 violation：

```text
R6_PROCESS_VIOLATION
STOP
```

---

# 96. R6 Definition of Done

## Bearer

- [ ] synthetic 256-bit Bearer validation。
- [ ] constant-time digest compare。
- [ ] protected REST routes。
- [ ] generic 401。
- [ ] WWW-Authenticate。
- [ ] no session enumeration pre-auth。

## Ticket

- [ ] authenticated mint endpoint。
- [ ] 32-byte random ticket。
- [ ] 30s default TTL。
- [ ] one-time。
- [ ] session-bound。
- [ ] Origin-bound。
- [ ] plaintext not stored。
- [ ] not durable。
- [ ] concurrency-safe single consume。
- [ ] ticket URL redaction。

## Browser policy

- [ ] shared OriginPolicy。
- [ ] exact allowlist。
- [ ] no wildcard。
- [ ] REST Origin enforcement。
- [ ] WS Origin enforcement。
- [ ] exact CORS。
- [ ] validated preflight。

## Abuse controls

- [ ] failed-auth limit。
- [ ] read/mutation limits。
- [ ] ticket mint limit。
- [ ] WS per-principal connection limit。
- [ ] upload concurrent + aggregate quota。
- [ ] Retry-After。

## Persistence boundary

- [ ] Phone Bearer absent from journal。
- [ ] ticket absent from journal。
- [ ] auth header absent from adapter。
- [ ] DSH credential not accepted as Phone credential。
- [ ] user text not rewritten。

## Security

- [ ] Host fence preserved。
- [ ] loopback bind preserved。
- [ ] no TLS listener。
- [ ] no new port。
- [ ] no production credential file。
- [ ] no `.credentials.yaml` read。
- [ ] security headers。

## Scope

- [ ] no R7 supervisor。
- [ ] no DSH token bootstrap。
- [ ] no UI。
- [ ] no SSH/Tailscale changes。
- [ ] R7 not started。

## Process

- [ ] R5A compliance before PASS。
- [ ] R5A compliance after PASS。
- [ ] no forbidden source-edit cmdlet。
- [ ] real DSH_HOME untouched。
- [ ] encoding clean。

## Regression

- [ ] R1-R5A green。
- [ ] R6 green。
- [ ] full suite 3x clean。
- [ ] external baselines unchanged。
- [ ] protected 13/13。

---

# 97. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R6-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R5A acceptance baseline
3. Scope completed
4. Files created
5. Files modified
6. Auth architecture
7. Bearer credential contract
8. Constant-time verification
9. REST authorization
10. Public vs authenticated health
11. WS ticket protocol
12. Ticket entropy/storage
13. Ticket TTL/one-time/session binding
14. Ticket Origin binding
15. Ticket race handling
16. Origin policy
17. CORS/preflight
18. Host/bind preservation
19. Rate limiting
20. WS connection limits
21. Upload quotas
22. Redaction/logging
23. Persistence boundary
24. Phone vs DSH credential separation
25. Security headers
26. TLS/tunnel boundary
27. Fixture flow
28. Test results
29. R1-R5A regression
30. External regression
31. Protected hashes
32. R5A compliance before/after
33. UTF-8/process gate
34. Security review
35. Known limitations
36. Deferred R7/R8/R9
37. R7 readiness
38. Exact stop statement
```

---

# 98. 报告必须逐项回答

1. R6 使用什么 Phone auth？
2. 长期 Bearer 是否进入 URL？
3. Bearer 原始值是否长期保存在 AuthService？
4. 是否使用 timing-safe comparison？
5. 哪些 REST route 不需要 auth？
6. 未认证访问未知 session 返回什么？
7. 认证后未知 session 返回什么？
8. health 未认证能看到哪些字段？
9. WS browser 为什么不用 Bearer header？
10. WS 用什么 ticket？
11. ticket entropy 多大？
12. ticket plaintext 是否在 server store？
13. ticket 默认 TTL？
14. ticket 是否 one-time？
15. 是否 session-bound？
16. 是否 Origin-bound？
17. 同 ticket 两个并发 upgrade 会成功几个？
18. ticket reuse 返回什么？
19. Bearer/token query 是否仍被拒绝？
20. ticket query 是否会被日志 redact？
21. ticket 是否写入 journal/snapshot？
22. Gateway restart 后旧 ticket 是否有效？
23. allowed Origin 默认有哪些？
24. 是否支持 configurable exact origins？
25. 是否允许 wildcard？
26. CORS 是否发送 wildcard？
27. OPTIONS 是否需要 Bearer？
28. Host fence 是否被放宽？
29. server 是否仍 loopback-only？
30. authenticated read/mutation 默认 limits？
31. failed-auth limit？
32. WS connection limit？
33. upload concurrent/aggregate quota？
34. rate limits 是否持久化？
35. Phone Bearer 是否传给 DSH adapter？
36. DSH auth cookie/token 是否可作为 Phone Bearer？
37. auth material 是否进入 R5 durable state？
38. 用户正文中的 “token” 是否被改写？
39. 是否创建 production phone credential file？
40. 是否读取 `.credentials.yaml`？
41. 是否新增 listener/port？
42. 是否启 TLS？
43. R5A compliance before/after 是否 PASS？
44. real DSH_HOME 是否仍未创建？
45. 是否使用 forbidden PowerShell text cmdlet？
46. encoding scan？
47. R1-R5A tests 是否全绿？
48. R6 新测试数量？
49. full suite 连续 clean 几次？
50. external regression 是否新增 fail？
51. protected hash 是否 13/13？
52. 是否进入 R7？

---

# 99. Stop Gate

R6 完成后：

```text
R6 COMPLETE — STOPPING HERE.
```

不得创建/执行：

```text
scripts/dsh-start.ps1
scripts/dsh-stop.ps1
scripts/dsh-restart.ps1
scripts/ssh-enable.ps1

production phone credential file
pairing-code UI
real DSH launch-token capture
real DSH auth-cookie capture
Windows ACL hardening
debug/mobile UI
Tailscale install/config
sshd enable
firewall changes
```

不得进入 R7。

---

# 100. 给 DSH 的执行指令

现在执行：

```text
Phase R6 — Phone Authentication & Security Hardening
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R5A-REPORT.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R5-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r5-persistence-design.md
D:\DSH-testing\dsh-remote-gateway\docs\r4-websocket-contract.md
D:\DSH-testing\dsh-remote-gateway\docs\r3-rest-contract.md
```

执行顺序：

1. 运行 `npm run compliance:r5a`，必须 PASS。
2. 确认 real `$DSH_HOME\remote` 不存在。
3. 写 `docs/r6-security-model.md`。
4. 写 `docs/r6-auth-contract.md`。
5. 实现 explicit AuthService injection。
6. 实现 Bearer digest/timing-safe validation。
7. 将 REST protected routes 放到 auth 后。
8. 实现 minimal unauthenticated health + full authenticated health。
9. 实现 shared OriginPolicy。
10. 实现 exact CORS/preflight。
11. 实现 authenticated `/api/v1/auth/ws-ticket`。
12. 实现 one-time/session-bound/origin-bound ticket store。
13. 接入 R4 `authorizeUpgrade` seam。
14. 实现 ticket concurrent-consume protection。
15. 实现 auth/routing rate limit。
16. 实现 WS connection cap。
17. 实现 upload quota。
18. 实现 auth URL/header redaction。
19. 验证 Phone auth 绝不进入 adapter/persistence。
20. 完成 R6 tests。
21. 重跑 R1-R5A。
22. full suite 连续 3 次。
23. 每轮确认 real DSH_HOME 未创建。
24. 重跑 external regressions。
25. 验证 protected hashes。
26. 运行 R5A compliance，必须再次 PASS。
27. BOM/U+FFFD/strict UTF-8 scan。
28. 生成 `PHASE-R6-REPORT.md`。
29. STOP。
30. 不进入 R7。

如果无法在 browser WebSocket 中做到：

```text
long-lived bearer never in URL
+
one-time ticket atomic consume
```

则：

```text
STOP IMPLEMENTATION
R6_WS_AUTH_MODEL_UNRESOLVED
```

如果 Origin/CORS/WS 三处无法共享一个一致 policy：

```text
STOP IMPLEMENTATION
R6_ORIGIN_POLICY_UNRESOLVED
```

如果任何 auth material 能进入 R5 durable state：

```text
STOP IMPLEMENTATION
R6_CREDENTIAL_PERSISTENCE_BREACH
```

如果 R5A process gate 失败：

```text
STOP
R6_PROCESS_VIOLATION
```
