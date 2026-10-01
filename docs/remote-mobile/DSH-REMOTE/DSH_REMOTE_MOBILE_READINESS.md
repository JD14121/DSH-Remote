# DSH 手机远程交互：电脑端准备任务书

> 目标：让手机端以后可以使用类似 ChatGPT 手机版的聊天界面，通过安全远程链路查看电脑端 DSH 正在执行的任务、持续接收实时输出，并发送新指令继续同一会话。
>
> 本文只要求完成 **电脑端 DSH / Bridge / Windows 主机侧准备**。暂不实现正式手机 App。
>
> 当前环境约束：
> - Windows 原生环境，不迁移到 WSL。
> - PowerShell。
> - Node.js 24.20.0。
> - DSH：`@deepseek-ai/dsh@0.1.5-rc.2`。
> - DSH 当前以 `web` 模式工作。
> - DeepSeek v4.1 flash/high 已具备原生多模态能力，不额外引入独立 vision 模型。
> - 优先兼容现有 DSH / Bridge 架构，不破坏已有功能、测试、受保护文件或既有 Phase 验收结果。

---

## 0. 最终目标架构

电脑端应准备成以下结构：

```text
手机 GPT-like UI
      │
      │  HTTPS / WebSocket
      │  （实际传输走 SSH Tunnel 或 Tailscale）
      ▼
127.0.0.1:<REMOTE_GATEWAY_PORT>
      │
      ▼
DSH Remote Gateway / Bridge
      │
      ├── 查询会话
      ├── 查询任务状态
      ├── 获取历史消息
      ├── 实时推送输出
      ├── 提交新消息
      ├── 中断当前任务
      └── 恢复断线会话
      │
      ▼
现有 DSH Web / DSH Session / DeepSeek
```

默认安全模型：

```text
公网
 × 不直接开放 DSH
 × 不直接开放 Remote Gateway
 × 不允许 0.0.0.0 裸监听

手机
 │
 ├── Tailscale
 │        或
 └── SSH Local Port Forward
          │
          ▼
Windows 主机 127.0.0.1
```

---

# 1. 第一阶段：审计现有 DSH，不立即重构

先检查当前仓库和正在运行的 DSH，确认现有能力可以复用到什么程度。

## 1.1 记录环境

生成：

```text
docs/remote-mobile/ENVIRONMENT.md
```

至少记录：

```powershell
node --version
npm --version
npx -y @deepseek-ai/dsh@0.1.5-rc.2 --help
```

记录：

- 当前 DSH 启动命令。
- 当前 `DSH_HOME`。
- 当前工作目录。
- DSH Web 使用端口。
- Bridge 使用端口。
- 配置文件位置。
- 会话数据位置。
- 日志位置。
- 当前 Node / DSH 相关进程树。
- 当前监听端口。

PowerShell 可使用：

```powershell
Get-CimInstance Win32_Process |
Where-Object {
    $_.CommandLine -match 'dsh|deepseek-ai|codex-dsh-bridge'
} |
Select-Object ProcessId, ParentProcessId, Name, CommandLine

Get-NetTCPConnection -State Listen |
Sort-Object LocalPort |
Format-Table LocalAddress, LocalPort, OwningProcess
```

---

## 1.2 审计现有 Web 接口

检查 DSH Web 是否已经存在以下能力：

1. 创建/恢复 conversation/session。
2. 获取历史消息。
3. 提交新 prompt。
4. 流式输出。
5. 当前任务状态。
6. cancel / abort。
7. tool-call / reasoning / final answer 等事件。
8. 页面刷新后恢复会话。
9. 多会话切换。
10. 文件/图片消息。

优先顺序：

```text
优先复用 DSH 现有接口
        ↓
如接口缺少统一封装
        ↓
在 Bridge 外层增加 Adapter
        ↓
最后才考虑修改 DSH 核心
```

### 禁止

不要通过以下方式实现手机输入：

- 向已经运行的 `node.exe` PID 强行注入 stdin。
- 自动模拟键盘向桌面 PowerShell 窗口输入。
- 依赖某个用户必须保持打开的 Terminal 标签页。
- 修改 DSH 上游核心源码，仅为了远程输入。

这些方式不适合作为稳定的远程聊天协议。

---

# 2. 建立统一 Remote Gateway

如果现有 Bridge 已经可以承担这一职责，则扩展现有 Bridge；不要重复创建第二套功能重叠的服务。

建议模块：

```text
src/
  remote/
    server.*
    auth.*
    sessions.*
    messages.*
    events.*
    dsh-adapter.*
    persistence.*
```

实际扩展名和目录遵循当前仓库既有规范。

Remote Gateway **默认只绑定**：

```text
127.0.0.1
```

不得默认：

```text
0.0.0.0
```

建议独立配置：

```env
DSH_REMOTE_HOST=127.0.0.1
DSH_REMOTE_PORT=9445
```

端口可调整，但必须集中配置，不得硬编码到多个文件。

---

# 3. 手机端未来所需的最小 API 契约

即使暂时不实现手机 UI，电脑端也必须提供稳定接口。

推荐 API 版本前缀：

```text
/api/v1
```

---

## 3.1 Health

```http
GET /api/v1/health
```

返回示例：

```json
{
  "ok": true,
  "gateway": "ready",
  "dsh": "connected",
  "version": "1"
}
```

不得返回 API Key、Token、完整环境变量。

---

## 3.2 会话列表

```http
GET /api/v1/sessions
```

每个会话至少包含：

```json
{
  "id": "session-id",
  "title": "conversation title",
  "status": "idle",
  "created_at": "...",
  "updated_at": "..."
}
```

推荐状态：

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

---

## 3.3 会话详情和历史

```http
GET /api/v1/sessions/:sessionId
GET /api/v1/sessions/:sessionId/messages
```

消息对象至少统一为：

```json
{
  "id": "message-id",
  "session_id": "session-id",
  "role": "user",
  "type": "message",
  "content": "...",
  "created_at": "...",
  "sequence": 123
}
```

`role` 至少允许：

```text
user
assistant
system
tool
```

---

## 3.4 输入新指令

```http
POST /api/v1/sessions/:sessionId/messages
```

请求：

```json
{
  "content": "继续执行 Phase 2C",
  "client_message_id": "uuid"
}
```

要求：

- `client_message_id` 用于防止手机断网重试造成重复提交。
- 返回服务器正式 `message_id`。
- 必须保持同一 DSH session/conversation 上下文。
- 不允许每条手机消息都隐式创建全新会话。

---

## 3.5 实时事件流

必须至少提供一种：

### 优先

```text
WebSocket
```

例如：

```text
WS /api/v1/events?session_id=<id>
```

如果当前架构更适合，也可使用：

```text
Server-Sent Events
```

实时事件至少覆盖：

```text
session.status
message.created
assistant.delta
assistant.completed
tool.started
tool.output
tool.completed
task.progress
task.completed
task.failed
task.cancelled
error
heartbeat
```

示例：

```json
{
  "event": "assistant.delta",
  "session_id": "abc",
  "sequence": 284,
  "timestamp": "...",
  "data": {
    "text": "正在检查..."
  }
}
```

---

## 3.6 中断当前任务

提供：

```http
POST /api/v1/sessions/:sessionId/cancel
```

必须真正映射到 DSH 当前任务的可控取消机制。

如果 DSH 上游没有细粒度取消接口：

1. 明确记录限制。
2. 实现最安全的 supervisor 级终止方案。
3. 不得使用 `Stop-Process -Name node` 这种会杀掉全部 Node 进程的方法。

---

# 4. 会话和任务状态必须可恢复

手机可能：

- 锁屏。
- 切换 Wi-Fi / 蜂窝网络。
- SSH 隧道断开。
- 浏览器被系统挂起。
- 重新打开页面。

因此 **WebSocket 不能成为唯一状态来源**。

必须持久化：

```text
session metadata
message history
event sequence
active task metadata
last known status
```

推荐目录：

```text
<DSH_HOME>\remote\
  sessions\
  events\
  state\
  logs\
```

如果项目已有数据库/存储层，则优先复用。

---

## 4.1 推荐事件日志

可先采用 JSONL：

```text
events/<session-id>.jsonl
```

每条事件有严格递增：

```json
{
  "sequence": 1042
}
```

手机重新连接时可以携带：

```text
last_sequence=1037
```

服务端补发：

```text
1038...
1042
```

从而解决断线期间漏消息问题。

---

## 4.2 不得在日志中保存

- DeepSeek API Key。
- SSH 密码。
- Tailscale auth key。
- Authorization header。
- Cookie/session secret。
- 完整敏感环境变量。

日志必须提供脱敏函数。

---

# 5. DSH 进程管理

不能要求用户必须在桌面上保持某个 PowerShell 窗口。

需要建立正式的 supervisor / 管理脚本。

建议：

```text
scripts/
  dsh-start.ps1
  dsh-stop.ps1
  dsh-restart.ps1
  dsh-status.ps1
  dsh-logs.ps1
  dsh-remote-test.ps1
```

---

## 5.1 `dsh-status.ps1`

至少显示：

```text
DSH:
  status
  PID
  uptime
  command line
  DSH_HOME
  web port

Bridge / Remote Gateway:
  status
  PID
  uptime
  bind address
  port

Recent session:
  session id
  status
  last event time
```

不能仅通过：

```powershell
Get-Process node
```

判断 DSH。

应结合 `CommandLine` 或保存 PID 文件。

---

## 5.2 PID 文件

推荐：

```text
run/
  dsh.pid
  remote-gateway.pid
```

启动后写入 PID。

停止前必须验证：

- PID 仍存在。
- CommandLine 确实属于目标服务。

避免 PID 被 Windows 复用后误杀别的进程。

---

## 5.3 日志

建议：

```text
logs/
  dsh.stdout.log
  dsh.stderr.log
  remote.stdout.log
  remote.stderr.log
```

提供：

```powershell
.\scripts\dsh-logs.ps1
```

默认显示最近 100 行，并支持 `-Follow`：

```powershell
.\scripts\dsh-logs.ps1 -Follow
```

---

# 6. Windows OpenSSH 准备

首先只检查，不自动改变系统配置：

```powershell
Get-Service sshd -ErrorAction SilentlyContinue

Get-WindowsCapability -Online |
Where-Object Name -like 'OpenSSH.Server*'
```

如果第二条提示：

```text
请求的操作需要提升
```

则记录：

```text
需要管理员 PowerShell
```

不要绕过 UAC。

---

## 6.1 SSH 验收

电脑端最终必须能从另一台设备执行：

```bash
ssh <windows-user>@<host>
```

登录到 PowerShell。

SSH 的用途：

1. 管理 DSH。
2. 查看日志。
3. 重启 Gateway。
4. 创建端口转发。

**不要求 SSH 直接承担聊天消息协议。**

---

# 7. Tailscale / SSH Tunnel 兼容准备

Remote Gateway 和 DSH Web 默认继续只监听：

```text
127.0.0.1
```

手机访问推荐两种模式。

---

## 模式 A：Tailscale + SSH Local Forward

手机建立：

```text
local 9445
    ↓
SSH over Tailscale
    ↓
PC 127.0.0.1:9445
```

电脑端不需要把 9445 暴露到 LAN。

---

## 模式 B：普通 SSH Local Forward

示例：

```bash
ssh -L 9445:127.0.0.1:9445 <user>@<pc>
```

手机浏览器未来访问：

```text
http://127.0.0.1:9445
```

如果未来独立前端运行在例如 9446，则同理转发。

---

# 8. Remote Gateway 鉴权

即使默认只绑定 loopback，也需要预留鉴权。

最低要求：

```http
Authorization: Bearer <token>
```

Token：

- 首次由电脑端生成高熵随机值。
- 不写进 Git。
- 不写进日志。
- 不硬编码。
- 存放于用户级配置或环境变量。

例如：

```env
DSH_REMOTE_TOKEN=<secret>
```

如果仅通过受控 SSH Tunnel，可以配置为“隧道可信模式”，但代码仍必须保留鉴权能力，便于未来扩展。

---

# 9. CORS / Origin

不要：

```text
Access-Control-Allow-Origin: *
```

默认仅允许未来手机 UI 的明确 Origin。

开发阶段如需放宽：

- 仅在 `development` 模式。
- 启动日志明确显示。
- production 默认拒绝未知 Origin。

---

# 10. 文件和图片能力预留

手机 GPT-like 页面未来应支持：

```text
文本
图片
文件
```

本阶段可以只完成协议，不必制作前端。

建议预留：

```http
POST /api/v1/uploads
POST /api/v1/sessions/:sessionId/messages
```

消息结构允许：

```json
{
  "content": [
    {
      "type": "text",
      "text": "分析这张图"
    },
    {
      "type": "attachment",
      "attachment_id": "..."
    }
  ]
}
```

由于当前模型本身具备多模态能力，不要增加额外视觉模型依赖。

上传要求：

- 限制单文件大小。
- 文件名规范化。
- 防目录穿越。
- MIME 类型验证。
- 临时文件自动清理。
- 不允许手机传任意路径让服务端读取 PC 全盘。

---

# 11. 电脑端提供一个最小调试页面

虽然正式手机 UI 暂不开发，但电脑端应提供一个极简测试页面：

```text
/debug/remote
```

只用于验收协议。

页面至少有：

```text
[Connection status]

Sessions
--------------------------------
session A   running
session B   idle

Current conversation
--------------------------------
User: ...
DSH:  ...

[ message input                ]
[ Send ] [ Cancel ]

Realtime events
--------------------------------
...
```

要求：

- 刷新后能恢复当前会话。
- 能实时显示 `assistant.delta`。
- 能提交新 prompt。
- 能 cancel。
- 不以美观为目标。
- 不引入大型 UI 框架，除非项目本来就在使用。

这个页面的意义是：在开发正式手机端之前，证明电脑端协议完整。

---

# 12. 网络断线处理

必须实现：

### heartbeat

例如 WebSocket 每 20–30 秒 heartbeat。

### 自动重连支持

服务端允许客户端携带：

```text
session_id
last_sequence
```

重新同步。

### 请求幂等

所有“发送消息”请求接受：

```text
client_message_id
```

重复 ID 返回已有结果，不再次提交给 DSH。

---

# 13. DSH Adapter

建立明确接口，把“手机协议”与“DSH 内部实现”隔离。

例如概念接口：

```ts
interface DshAdapter {
  listSessions(): Promise<SessionSummary[]>
  getSession(id: string): Promise<Session>
  getMessages(id: string): Promise<Message[]>

  sendMessage(
    sessionId: string,
    message: UserMessage
  ): Promise<SubmitResult>

  subscribe(
    sessionId: string,
    listener: EventListener
  ): Unsubscribe

  cancel(sessionId: string): Promise<void>
}
```

手机 Gateway 不应直接依赖：

```text
DSH 内部私有对象
DOM
浏览器页面元素
桌面 Terminal
```

---

# 14. 保护现有 DSH / Bridge

本任务应优先采用 **additive implementation**。

未经必要性证明，不修改：

- 已验收核心逻辑。
- 现有 canonical hashing。
- YAML validation。
- evidence collection。
- 已保护文件。
- 已有 Phase 完成条件。

如果必须修改受保护文件：

1. 先记录修改必要性。
2. 保存修改前 SHA-256。
3. 修改后运行全部回归测试。
4. 在最终报告列出 hash diff。
5. 不静默改变已有行为。

---

# 15. 测试

新增自动化测试目录，例如：

```text
tests/remote/
```

至少覆盖：

### REST

- health。
- list sessions。
- history。
- submit message。
- invalid session。
- duplicate `client_message_id`。
- cancel。

### realtime

- connect。
- assistant delta。
- event ordering。
- disconnect。
- reconnect。
- replay missing events。

### persistence

- Gateway 重启后恢复历史。
- Gateway 重启后 sequence 不倒退。
- 损坏事件文件有明确错误，不静默丢数据。

### security

- 未授权请求失败。
- 错误 token 失败。
- path traversal 被拒绝。
- 日志不包含 token。
- 默认仅 bind `127.0.0.1`。

---

# 16. 一键验收脚本

创建：

```text
scripts/dsh-remote-test.ps1
```

它应自动检查：

```text
[1] DSH process            PASS/FAIL
[2] DSH Web                PASS/FAIL
[3] Remote Gateway         PASS/FAIL
[4] bind == 127.0.0.1      PASS/FAIL
[5] health endpoint        PASS/FAIL
[6] auth                   PASS/FAIL
[7] session list           PASS/FAIL
[8] history                PASS/FAIL
[9] realtime connection    PASS/FAIL
[10] prompt submit         PASS/FAIL
[11] streamed response     PASS/FAIL
[12] reconnect/replay      PASS/FAIL
[13] cancel                PASS/FAIL
[14] persistence           PASS/FAIL
```

如果会实际向模型发送测试 prompt，使用：

```text
REMOTE_SMOKE_TEST
```

并确保不会修改用户真实项目状态。

---

# 17. 建议电脑端启动方式

最终期望用户可以：

```powershell
.\scripts\dsh-start.ps1
```

然后：

```powershell
.\scripts\dsh-status.ps1
```

输出类似：

```text
DSH Remote Stack
================

DSH
  Status:      RUNNING
  PID:         18432
  Web:         127.0.0.1:9444
  Session:     abc123

Remote Gateway
  Status:      RUNNING
  PID:         19120
  API:         127.0.0.1:9445
  WebSocket:   READY
  Auth:        ENABLED

Persistence
  Status:      HEALTHY
  Last event:  2026-09-19T11:35:27+08:00
```

---

# 18. 手机接入前的 Definition of Done

只有全部满足，才算电脑端准备完成。

## DSH

- [ ] DSH 可以脱离桌面 Terminal 持续运行。
- [ ] 能确定当前 DSH PID。
- [ ] 能确定 DSH Web 端口。
- [ ] 能恢复既有 conversation/session。
- [ ] 能向同一 session 发送新 prompt。
- [ ] 能安全取消任务。

## Gateway

- [ ] 提供 REST API。
- [ ] 提供 WebSocket 或 SSE。
- [ ] 能实时转发 DSH 输出。
- [ ] 能查询历史消息。
- [ ] 能查询 task status。
- [ ] 支持断线重连。
- [ ] 支持事件 replay。
- [ ] 支持 `client_message_id` 幂等。
- [ ] 默认仅监听 `127.0.0.1`。
- [ ] 支持 Bearer Token。

## Persistence

- [ ] session 可恢复。
- [ ] message history 可恢复。
- [ ] event sequence 持久化。
- [ ] Gateway 重启后不会丢失已完成历史。
- [ ] 日志无密钥泄漏。

## Windows Remote

- [ ] `sshd` 可正常使用。
- [ ] 手机/另一设备能 SSH 登录。
- [ ] SSH Local Forward 可以访问 Gateway。
- [ ] 不需要开放 Gateway 公网端口。
- [ ] Windows Firewall 不额外开放不必要端口。

## Operations

- [ ] `dsh-start.ps1`
- [ ] `dsh-stop.ps1`
- [ ] `dsh-restart.ps1`
- [ ] `dsh-status.ps1`
- [ ] `dsh-logs.ps1`
- [ ] `dsh-remote-test.ps1`

## Tests

- [ ] 原测试全部通过。
- [ ] 新 remote 测试全部通过。
- [ ] 一键 smoke test 通过。
- [ ] 生成最终实施报告。

---

# 19. 实施顺序

严格按以下顺序执行：

```text
Phase R0
现状审计
    ↓
Phase R1
DSH Adapter
    ↓
Phase R2
Session / Message / Event 数据模型
    ↓
Phase R3
REST API
    ↓
Phase R4
WebSocket / SSE
    ↓
Phase R5
Persistence + reconnect/replay
    ↓
Phase R6
Auth + security
    ↓
Phase R7
PowerShell process management
    ↓
Phase R8
Debug Web UI
    ↓
Phase R9
SSH Tunnel 验收
    ↓
Phase R10
Full regression + final report
```

每一阶段完成后：

1. 运行现有全部测试。
2. 运行该阶段新增测试。
3. 记录新增/修改/删除文件。
4. 记录测试数量。
5. 记录已知限制。
6. 确认未提前进入下一阶段。

---

# 20. DSH 执行规则

请按下面规则直接执行，不要只给出建议。

1. **首先读取当前仓库和现有文档**，确认当前架构，而不是凭假设重写。
2. 优先复用已有 Bridge、session、event、Web 能力。
3. 不迁移到 WSL。
4. 不替换现有 DeepSeek v4.1 flash/high 模型配置。
5. 不引入额外 vision 模型。
6. 不把服务默认暴露到 `0.0.0.0`。
7. 不把 API key/token 写入仓库。
8. 不通过桌面键盘模拟或 PID stdin 注入实现聊天。
9. 不为了方便而停止所有 `node.exe`。
10. 每个 Phase 都必须有测试和报告。
11. 若发现 DSH 已原生提供等价接口，则优先包装该接口，避免重复实现。
12. 若发现某项能力在当前 DSH 版本无法可靠实现，停止该部分开发并在报告中说明：
    - 缺失能力。
    - 已验证证据。
    - 最小替代方案。
    - 对手机端设计的影响。
13. 未经测试不得宣布阶段完成。

---

# 21. 首次执行时只做 Phase R0

现在先完成：

```text
Phase R0 — Remote Mobile Readiness Audit
```

本阶段只允许：

- 检查现有仓库。
- 检查现有 DSH / Bridge。
- 检查进程和端口。
- 检查现有 API / WebSocket / SSE。
- 找出 session/history/input/stream/cancel 的真实实现位置。
- 输出架构图。
- 输出 gap analysis。
- 输出后续 Phase R1–R10 的具体文件级实施计划。

生成：

```text
REMOTE-MOBILE-R0-REPORT.md
```

报告必须包含：

```text
1. Environment
2. Current process topology
3. Current network topology
4. Current DSH Web capabilities
5. Current Bridge capabilities
6. Session persistence mechanism
7. Existing streaming mechanism
8. Existing prompt submission path
9. Existing cancellation mechanism
10. Security posture
11. Capability matrix
12. Gaps
13. Proposed adapter boundary
14. Planned files for R1
15. Regression baseline
16. Risks / blockers
```

**完成 R0 后停止。不要自动进入 R1。**

---

# 22. 本项目最终用户体验目标

电脑端全部完成以后，手机侧未来应能够做到：

```text
打开一个类似 ChatGPT 的页面
        ↓
看到电脑 DSH 的会话列表
        ↓
打开正在进行的任务
        ↓
看到此前历史
        ↓
实时看到 DSH 新输出
        ↓
锁屏/断网
        ↓
重新进入
        ↓
自动补齐遗漏输出
        ↓
在输入框发送新指令
        ↓
DSH 在原 conversation 中继续执行
```

手机端不应该需要知道：

- DSH PID。
- Node 进程。
- DSH 内部路径。
- PowerShell 窗口。
- DeepSeek API Key。

这些全部由电脑端 Gateway 隔离。

---

## 最终原则

手机不是“远程控制一个 PowerShell 窗口”。

正确模型是：

```text
手机 = Chat Client
电脑 = DSH Server
SSH/Tailscale = Secure Transport
Remote Gateway = Stable Protocol Boundary
DSH = Agent Runtime
```

只有按这种方式准备，手机端才能真正做到接近 GPT App 的连续会话体验，而不是一个不稳定的远程终端。
