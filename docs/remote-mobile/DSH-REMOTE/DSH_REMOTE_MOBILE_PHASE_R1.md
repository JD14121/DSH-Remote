# Phase R1 — DSH Adapter Boundary & Contract Tests

> 任务类型：Implementation Phase
>
> 前置阶段：Phase R0 — Remote Mobile Readiness Audit
>
> 本阶段目标：建立手机 Remote Gateway 与 DSH 之间唯一、稳定、可测试的适配边界。
>
> **本阶段只实现 Adapter + Wire Client + Translators + Contract Tests。**
>
> **禁止实现 HTTP Server、对外 WebSocket Server、Bearer Auth、持久化、PowerShell Supervisor、Debug UI、SSH/Tailscale。**
>
> 完成 R1 后必须停止，不得自动进入 R2。

---

# 0. 已确认的架构决策

## 0.1 Substrate

采用：

```text
Substrate A — DSH Web RPC
```

即：

```text
POST /api/<channel>/<endpoint>
WS   /api/remote.mux
```

通过 DSH Web RPC 访问当前正在运行的 DSH。

原因：

1. 可读取用户当前 DSH Web 中已有 session。
2. 可向同一 session 继续提交 prompt。
3. 可通过 `follow` 获取实时 assistant stream。
4. 支持真正的 `session.cancel`。
5. 支持多 session / 多客户端。
6. 不需要修改 DSH `profiles/web`。
7. 不创建第二套 DSH runtime/session store。

---

## 0.2 隔离原则

所有 DSH 私有 wire knowledge 必须被限制在：

```text
src/remote/dsh-adapter.mjs
src/remote/wire/*
```

其余未来 Gateway 代码不得知道：

- DSH HTTP envelope 格式。
- Typert Remote endpoint 名。
- `dsh-auth-*` cookie。
- `/api/remote.mux` logical stream framing。
- DSH 内部类名。
- DSH DOM。
- DSH Web 页面结构。
- DSH Terminal / PowerShell。
- npx cache 内部路径。

未来如果 DSH wire 改变，应只替换 Adapter/Wire 层。

---

# 1. 工作目录

R1 必须创建为一个新的 standalone Node 项目。

推荐：

```text
D:\DSH-testing\dsh-remote-gateway
```

目录：

```text
D:\DSH-testing\dsh-remote-gateway\
  package.json
  src\
    remote\
  tests\
    remote\
  PHASE-R1-REPORT.md
```

不得把 R1 新代码放入：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
D:\DSH-testing\codex-dsh-bridge
D:\DSH-testing\manual-loop
D:\DSH-work-test\.dsh
```

也不得写入：

```text
C:\Users\YOURNAME\AppData\Local\npm-cache\...
```

---

# 2. 环境约束

保持：

```text
Windows 11
Windows PowerShell 5.1
Node.js v24.20.0
npm 11.19.0
DSH @deepseek-ai/dsh@0.1.5-rc.2
DSH_HOME D:\DSH-work-test\.dsh
DSH Web http://127.0.0.1:3080
```

本阶段不得：

- 升级 DSH。
- 重新安装 `profiles/web`。
- 修改 `settings.yaml`。
- 修改 `cordis.patch.yml`。
- 添加额外 vision model。
- 启动 Tailscale。
- 修改 Windows Firewall。
- 启用 sshd。
- 修改现有 Bridge。
- 修复 Phase 2C。
- 修复 Phase 3C.3。
- 修复既有 red baseline。

---

# 3. Bootstrap 决策

R1 使用：

```text
Deferred Bootstrap
```

即：

```text
R1 contract tests
        ↓
fixture auth / fixture transport
        ↓
DSH Adapter
```

真实 DSH boot token/cookie 获取：

```text
DEFER → R7
```

R1 可以提供：

```text
DshAuthProvider
FixtureAuthProvider
StaticAuthProvider（仅测试/手工验证）
```

但不得：

- 从桌面 console 自动抓 token。
- 修改启动器。
- 保存真实 token 到仓库。
- 把真实 cookie 放入 fixture。
- 把真实 launch URL/token 写进 report。

---

# 4. 项目初始化

创建：

```text
D:\DSH-testing\dsh-remote-gateway
```

`package.json` 至少：

```json
{
  "name": "dsh-remote-gateway",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "test": "node --test tests/remote"
  }
}
```

尽量使用 Node 24 内置能力。

除非确有必要，不增加 runtime dependency。

如需 schema validation：

优先：

```text
hand-written narrow validators
```

或复用项目已经明确批准的轻量依赖。

不要为了 R1 引入大型框架。

---

# 5. 必须创建的文件

## 5.1 Adapter

```text
src/remote/dsh-adapter.mjs
```

公开接口：

```js
listSessions()
getSession(id)
getMessages(id, options)
sendMessage(sessionId, message)
subscribe(sessionId, listener)
cancel(sessionId)
```

建议构造：

```js
new DshAdapter({
  rpcClient,
  versionGuard,
  authProvider,
})
```

不得在模块 import 时建立网络连接。

---

## 5.2 Error Vocabulary

创建：

```text
src/remote/adapter-errors.mjs
```

至少定义：

```text
DSH_UNAVAILABLE
SESSION_NOT_FOUND
SESSION_COLD
PROMPT_REJECTED
CANCEL_UNSUPPORTED
WIRE_VERSION_MISMATCH
AUTH_UNAVAILABLE
AUTH_REJECTED
WIRE_PROTOCOL_ERROR
STREAM_ABORTED
```

错误对象至少：

```js
{
  code,
  message,
  cause?,
  retryable?,
  details?
}
```

不得把：

```text
cookie
token
Authorization
credentials
```

包含在 `message` / `details`。

---

# 6. DSH RPC Client

创建：

```text
src/remote/wire/dsh-rpc-client.mjs
```

职责：

```text
HTTP unary RPC
WebSocket mux logical streams
rpcId correlation
AbortSignal cancellation
transport error normalization
```

禁止把：

```text
session normalization
status derivation
mobile API schema
persistence
```

放到 RPC client。

---

## 6.1 Unary RPC

支持概念调用：

```js
rpc.call({
  channel,
  method,
  payload,
  signal
})
```

生成：

```json
{
  "type": "client-request",
  "rpcId": "...",
  "method": "...",
  "payload": {}
}
```

校验响应：

```json
{
  "type": "server-response",
  "rpcId": "...",
  "result": {}
}
```

必须检查：

```text
type
rpcId
result.ok
result.error
```

禁止：

```text
收到任何 JSON 就当成功
```

---

## 6.2 HTTP error mapping

测试并映射：

```text
400
401
403
404
415
network failure
AbortError
malformed JSON
invalid envelope
rpcId mismatch
```

401/403 不得打印 cookie/token。

---

# 7. Route Constants

创建：

```text
src/remote/wire/dsh-routes.mjs
```

所有 DSH Remote endpoint 名集中在这里。

至少包含：

```text
session list
session create
session fork
session prompt
session attachment
session updateQueue
session cancel
session page
session follow
session control
```

禁止在其他模块散落：

```js
"session-controller/prompt"
```

之类的 magic strings。

---

# 8. Runtime Validators

创建：

```text
src/remote/wire/dsh-types.mjs
```

至少检查：

```text
SessionListValue
SessionWireHeader
SessionPromptValue
SessionPage
SessionFollowFrame
SessionAssistantStreamFrame
SessionCancelValue
```

原则：

```text
必须验证协议关键字段
允许 opaque payload 保持 opaque
不得猜测 LLM chunk 内部 shape
```

尤其：

```text
assistant-stream.frame.chunk
```

必须当作 opaque `JsonValue`。

不要解析为自定义 token schema。

---

# 9. Authentication Interface

创建：

```text
src/remote/wire/dsh-auth.mjs
```

接口示例：

```js
class DshAuthProvider {
  async getAuth() {}
}
```

返回内部结构，例如：

```js
{
  cookie: "...",
  authority: "127.0.0.1:3080"
}
```

注意：

这不是未来手机 Bearer Token。

这是：

```text
Remote Gateway → DSH Web
```

的内部凭据。

两层鉴权必须明确区分：

```text
Phone → Gateway
    future R6 Bearer

Gateway → DSH
    DSH cookie / token
```

R1 fixture 可以使用：

```text
test-cookie
```

但不得使用真实 DSH token。

---

# 10. Prompt Translation

创建：

```text
src/remote/translate/from-prompt.mjs
```

输入概念结构：

```js
{
  content,
  client_message_id,
  mode
}
```

转换为：

```text
SessionPromptRequest
```

其中：

```text
client_message_id
      ↓
requestId
```

必须一一对应。

不得额外生成第二个 idempotency key。

支持：

```text
mode = queue
mode = steer
```

若调用方未提供 mode：

R1 Adapter 层不得偷偷决定产品策略。

推荐：

```text
throw INVALID_PROMPT_MODE
```

或要求调用方明确传入。

后续 R3/UI 再决定默认策略。

---

# 11. Session / Message Translation

创建：

```text
src/remote/translate/to-messages.mjs
```

R1 只完成“可用且保守”的 normalization。

目标输出：

```js
{
  id,
  session_id,
  role,
  type,
  content,
  created_at,
  sequence
}
```

role：

```text
user
assistant
system
tool
```

如果遇到尚未理解的 `SessionWireEvent`：

不得丢弃。

应返回：

```js
{
  role: "system",
  type: "unknown",
  content: <opaque-safe-value>,
  ...
}
```

或等价 passthrough representation。

目的：

```text
新 DSH event type 出现时 fail-visible
而不是 silent data loss
```

---

# 12. Session Summary Translation

创建：

```text
src/remote/translate/to-summary.mjs
```

目标：

```js
{
  id,
  title,
  status,
  created_at,
  updated_at
}
```

R1 不负责完整九状态 state machine。

允许：

```text
status = raw/derived placeholder
```

但必须设计接口，使 R2 可以替换为：

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

不要在 R1 提前实现持久化状态机。

---

# 13. Version Guard

创建：

```text
src/remote/version-guard.mjs
```

必须 fail closed。

目标版本：

```text
@deepseek-ai/dsh@0.1.5-rc.2
```

允许通过：

```text
explicit observed version
fixture version
```

验证。

若版本未知：

```text
WIRE_VERSION_MISMATCH
```

不得：

```text
warning 后继续
```

因为当前方案依赖 browser-internal wire。

---

# 14. WebSocket / Follow Stream

R1 必须实现 DSH-side `follow` consumer。

注意：

这是：

```text
Gateway adapter → DSH /api/remote.mux
```

不是未来：

```text
Phone → Gateway
```

的 WebSocket Server。

---

## 14.1 subscribe

目标：

```js
const unsubscribe = await adapter.subscribe(sessionId, listener)
```

listener 接收至少：

```text
snapshot
event
assistant-stream:start
assistant-stream:chunk
assistant-stream:end
error
```

保留原始顺序。

不得：

- 重新排序 chunk。
- 合并未知事件。
- 假设 chunk 为 string。
- 假设一个 WebSocket 只对应一个 session。
- 把 transport disconnect 当成 session failure。

---

## 14.2 abort

`unsubscribe()` 必须：

- abort logical stream。
- 不关闭整个 DSH server。
- 不取消 session 的 Agent task。
- 不影响同一 physical WS 上其他 logical stream。

---

# 15. Cancel

`adapter.cancel(sessionId)`：

必须映射到：

```text
session.cancel
```

若 DSH 返回“session cold / no live state”：

映射：

```text
SESSION_COLD
```

不得：

```text
return success
```

不得 fallback：

```text
taskkill node
Stop-Process
```

R1 不实现 supervisor fallback。

---

# 16. getMessages

必须使用：

```text
session.page
```

和必要的 pagination。

不得直接读取：

```text
session.v3.jsonl.zstd
```

原因：

- 文件可能很大。
- 是 live append log。
- DSH 已经有正式 page API。
- 直接解析会把 Gateway 与内部存储格式绑死。

R1 tests 可以使用 fixture page。

---

# 17. Fixtures

创建：

```text
tests/remote/fixtures/
```

至少包含：

```text
version.json
session-list.response.json
session-page.response.json
prompt.accepted.response.json
cancel.success.response.json
cancel.cold.response.json
follow.snapshot.json
follow.event.json
follow.assistant-start.json
follow.assistant-chunk.json
follow.assistant-end.json
error.401.json
error.403.json
error.invalid-envelope.json
```

文件名可合理调整。

---

## 17.1 Fixture Hygiene

fixture 中不得出现：

```text
真实 token
真实 cookie
真实 API Key
真实 credentials
完整用户 prompt
个人敏感信息
```

真实 session id 可替换为 deterministic fixture id：

```text
session-00000000-0000-0000-0000-000000000001
```

---

## 17.2 Fixture Provenance

创建：

```text
tests/remote/fixtures/README.md
```

记录：

```text
Captured/derived date
Observed DSH version
Observed endpoint
Fields redacted/replaced
Whether fixture is:
  real-wire-derived
  hand-constructed
  negative-test-only
```

不要声称 hand-constructed fixture 是 live capture。

---

# 18. Tests

创建：

```text
tests/remote/dsh-adapter.test.mjs
tests/remote/wire-envelope.test.mjs
tests/remote/translate-messages.test.mjs
tests/remote/translate-summary.test.mjs
tests/remote/request-id-idempotency.test.mjs
tests/remote/stream-follow.test.mjs
tests/remote/version-guard.test.mjs
```

---

## 18.1 Adapter Tests

至少验证：

```text
listSessions()
getSession()
getMessages()
sendMessage()
subscribe()
cancel()
```

包括：

```text
happy path
DSH unavailable
session missing
malformed response
abort
```

---

## 18.2 Idempotency Test

必须验证：

同一个：

```text
client_message_id
```

两次提交：

Adapter 必须向 DSH 两次传递相同：

```text
requestId
```

不得生成两个 requestId。

注意：

R1 Adapter 本身不需要维护 duplicate registry。

真正 dedupe authority 是 DSH。

---

## 18.3 Stream Tests

覆盖：

```text
snapshot
event
assistant start
assistant chunk
assistant end
abort
fresh reconnect snapshot
logical stream independence
```

---

## 18.4 Version Guard

覆盖：

```text
0.1.5-rc.2 → PASS
different version → FAIL
missing version → FAIL
invalid version → FAIL
```

---

# 19. Live Manual Validation

R1 自动测试默认不得依赖正在运行的 DSH。

但完成 fixture tests 后，允许进行一次：

```text
read-only + controlled prompt
```

的手工 live verification。

前提：

- 不修改 DSH profile。
- 不修改 DSH launcher。
- 不持久化真实 token。
- 不输出真实 token 到 report。
- 不破坏用户当前 session。

优先验证：

```text
list sessions
page one session
follow one session
```

Prompt/cancel 若无法安全获得 auth：

```text
记录为 DEFERRED TO R7
```

这不阻止 R1 fixture contract 完成。

R1 不得为了“live 全通过”提前实现 R7。

---

# 20. R1 Regression Requirements

R1 修改必须与现有项目完全隔离。

完成后重新运行：

## dsh-gpt-planner-bridge declared suite

预期：

```text
327 pass / 0 fail
```

## dsh-gpt-planner-bridge full corpus

预期 baseline：

```text
676 total
9 fail
```

且：

```text
只能是原来同一个 render-provenance.test.mjs
原来相同失败 case
不得出现新 fail
不得“顺便修复”这些 fail
```

## codex-dsh-bridge declared suite

预期：

```text
175 pass / 0 fail
```

## codex-dsh-bridge full set incl reviewer

预期 baseline：

```text
220 total
219 pass
1 fail
```

且必须仍为原 baseline case。

---

# 21. Protected Surface

R1 不得修改以下任何内容：

```text
D:\DSH-testing\dsh-gpt-planner-bridge\
D:\DSH-testing\codex-dsh-bridge\
D:\DSH-testing\manual-loop\
D:\DSH-work-test\.dsh\
DSH npx cache
```

特别是 13 个 protected codex-dsh-bridge files 必须 byte-identical。

比较：

```text
SHA-256
```

不要用：

```text
mtime
```

作为是否修改的证据。

---

# 22. Twin Tree Protection

机器存在：

```text
D:\DSH work test
D:\DSH-work-test
```

两者是不同目录。

真实：

```text
DSH_HOME = D:\DSH-work-test\.dsh
```

所有 live validation：

必须显式使用：

```text
D:\DSH-work-test
```

不得 cwd 推断。

R1 standalone project：

```text
D:\DSH-testing\dsh-remote-gateway
```

不得创建：

```text
D:\DSH work test\dsh-remote-gateway
```

---

# 23. Security Requirements

虽然 R6 才实现完整 security，本阶段仍要求：

- 不记录真实 DSH token。
- 不记录 cookie。
- 不记录 Authorization。
- 不读取 `.credentials.yaml`。
- 不复制 `.credentials.yaml`。
- 不输出环境变量全集。
- fixture 中无 secret。
- exception message 无 secret。
- debug logging 默认关闭。

---

# 24. R1 Definition of Done

全部满足才允许宣布 R1 complete。

## Project

- [ ] 独立 `dsh-remote-gateway` 项目建立。
- [ ] 未修改现有两套 Bridge。
- [ ] 未修改 DSH profile/home。
- [ ] Node >=24。
- [ ] ESM。

## Adapter

- [ ] `listSessions()`
- [ ] `getSession()`
- [ ] `getMessages()`
- [ ] `sendMessage()`
- [ ] `subscribe()`
- [ ] `cancel()`

## Wire

- [ ] unary envelope validated。
- [ ] rpcId checked。
- [ ] error mapping。
- [ ] logical streaming。
- [ ] AbortSignal。
- [ ] unknown wire shape fails visibly。

## Translation

- [ ] `client_message_id → requestId`。
- [ ] message normalization。
- [ ] opaque assistant chunk preserved。
- [ ] unknown event not silently discarded。

## Compatibility

- [ ] DSH `0.1.5-rc.2` version guard。
- [ ] unexpected version fails closed。
- [ ] all endpoint names centralized。

## Tests

- [ ] R1 new tests all pass。
- [ ] fixture provenance documented。
- [ ] no secrets in fixtures。
- [ ] original declared suites retain baseline。
- [ ] full corpus has no new failures。
- [ ] protected hashes unchanged。

## Scope

- [ ] no HTTP server。
- [ ] no external WS server。
- [ ] no auth server。
- [ ] no persistence。
- [ ] no supervisor。
- [ ] no SSH changes。
- [ ] no UI。
- [ ] R2 not started。

---

# 25. Required Phase Report

完成后创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R1-REPORT.md
```

必须包含：

```text
1. Executive summary
2. Scope completed
3. Architecture
4. Substrate decision confirmation
5. Files created
6. Files modified
7. Adapter public contract
8. Wire endpoints implemented
9. Error vocabulary
10. Version guard
11. Fixture inventory
12. Fixture provenance
13. Automated test results
14. Live manual validation
15. Regression comparison
16. Protected hash verification
17. Security review
18. Known limitations
19. Deferred items
20. R2 readiness
21. Exact stop statement
```

---

# 26. Report 必须明确回答的问题

报告中逐条回答：

1. 是否有任何现有项目文件被修改？
2. 是否修改过 `D:\DSH-work-test\.dsh`？
3. 是否修改过 DSH profile？
4. 是否读取过 `.credentials.yaml`？
5. 是否保存过真实 launch token/cookie？
6. Adapter 是否能看到现有 DSH sessions？
7. `client_message_id` 是否原样成为 DSH `requestId`？
8. `follow` 是否保持 frame ordering？
9. cancel 是否真正调用 `session.cancel`？
10. cold-session cancel 如何表示？
11. 是否直接解析过 `.zstd` session log？
12. DSH version mismatch 是否 fail closed？
13. R1 是否启动了任何对外 listener？
14. 原 regression baseline 是否有新增失败？
15. 13 个 protected hashes 是否 unchanged？
16. 是否进入 R2？

---

# 27. Stop Gate

完成 R1 后：

```text
STOP
```

不得创建：

```text
src/remote/server.mjs
src/remote/events.mjs persistence implementation
src/remote/auth.mjs phone Bearer implementation
public/debug/remote/*
scripts/dsh-start.ps1
scripts/dsh-stop.ps1
```

除非这些文件仅作为空 placeholder，且 R1 报告明确说明：

```text
not implemented
```

但推荐不要创建 placeholder。

最终输出：

```text
PHASE-R1-REPORT.md
```

然后等待人工验收。

---

# 28. 给 DSH 的执行指令

请现在执行：

```text
Phase R1 — DSH Adapter Boundary & Contract Tests
```

严格遵守：

```text
R1 only
```

先读取：

```text
D:\DSH-testing\REMOTE-MOBILE-R0-REPORT.md
D:\DSH-testing\docs\remote-mobile\ENVIRONMENT.md
```

然后：

1. 创建独立 `D:\DSH-testing\dsh-remote-gateway`。
2. 记录新项目创建前的 regression/protected baseline。
3. 实现 Adapter 和 wire client。
4. 建立 fixtures。
5. 完成 R1 tests。
6. 运行完整 regression。
7. 核验 protected hashes。
8. 生成 `PHASE-R1-REPORT.md`。
9. 停止。
10. 不进入 R2。

如果发现 R0 对 DSH wire 的任何事实不准确：

```text
STOP IMPLEMENTATION
```

在报告中输出：

```text
R0_ASSUMPTION_INVALIDATED
```

并附：

- 哪个假设失效。
- 实际证据。
- 影响哪些 R1 文件。
- 推荐修正方案。

不得为了绕过错误假设而偷偷改变架构。

