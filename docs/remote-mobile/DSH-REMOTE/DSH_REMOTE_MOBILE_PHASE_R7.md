# Phase R7 — Production Supervisor, Credential Bootstrap & Live DSH Integration

> 前置阶段：R5 / R5A / R6
>
> 当前项目：`D:\DSH-testing\dsh-remote-gateway`
>
> 当前环境：
>
> ```text
> Windows 11 Home
> PowerShell 5.1
> Node v24.20.0
> npm 11.19.0
> DSH @deepseek-ai/dsh@0.1.5-rc.2
> DSH_HOME = D:\DSH-work-test\.dsh
> DSH Web = 127.0.0.1:3080
> Gateway = 127.0.0.1:9445
> ```
>
> 本阶段目标：第一次把 R1–R6 的 fixture-driven Gateway 变成可实际运行的本机 production stack。
>
> R7 负责：
>
> ```text
> production supervisor
> production Phone credential generation/storage
> explicit Windows ACL hardening
> first production $DSH_HOME\remote creation
> DSH process ownership
> DSH launch-token capture
> launch-token → dsh-auth cookie bootstrap
> real authenticated DshAdapter
> redacted disk logs + rotation
> start / stop / restart / status operator commands
> live authenticated smoke
> live reconciliation smoke
> ```
>
> R7 不实现 Mobile UI（R8）；不启用 SSH/Tailscale、不开放防火墙、不改变 loopback bind（R9）。
>
> 完成后生成 `PHASE-R7-REPORT.md` 并停止，不得自动进入 R8。

---

# 0. R6 验收基线

```text
R1:    82 / 82
R2:   113 / 113
R3:   161 / 161
R4:   132 / 132
R5:   155 / 155
R5A:   12 / 12
R6:   168 / 168
Full: 823 / 823
```

并且：

```text
3 consecutive clean full-suite runs
R5A compliance before R6: PASS
R5A compliance after R6:  PASS
protected hashes: 13 / 13
runtime deps: ws@8.21.3 only
```

R7 开始前再次运行：

```text
npm run compliance:r5a
npm test
```

必须全部通过。

---

# 1. 两段式执行

R7 必须拆为：

```text
Gate A — Pre-Production
Gate B — First Production Start
```

## Gate A

在 Gate A 完成前禁止创建：

```text
D:\DSH-work-test\.dsh\remote
```

所有测试使用：

```text
OS temp root
synthetic Phone token
synthetic DSH launch-token output
synthetic dsh-auth cookie
synthetic DSH process
```

Gate A 必须完成：

```text
supervisor unit tests
credential-store tests
ACL tests on temp directory
log/redaction tests
launch-token parser tests
auth-cookie bootstrap fixture tests
process ownership tests
shutdown/restart tests
operator-command tests
R1-R6 regressions
R5A compliance
```

全部通过后才能进入 Gate B。

## Gate B

Gate B 允许：

```text
create real $DSH_HOME\remote
apply Windows ACL
create production Phone credential
start real DSH
capture launch token in memory
exchange to real dsh-auth cookie in memory
start real Gateway
run live authenticated smoke
run clean restart/stop/start smoke
```

不得：

```text
modify DSH profile
read .credentials.yaml
expose 9445
enable sshd
install Tailscale
change firewall
```

---

# 2. Production Architecture

推荐：

```text
PowerShell operator command
        │
        ▼
Node production supervisor
        │
        ├── production Phone credential
        │       └── AuthService
        │
        ├── spawn DSH child
        │       └── capture launch token in memory
        │               └── exchange → dsh-auth cookie in memory
        │
        ├── construct real DshAdapter(cookie)
        │
        ├── PersistenceService(%DSH_HOME%\remote)
        │
        ├── StatusService / Reconciler
        │
        └── HTTP + WS Gateway :9445 loopback
```

Node supervisor 是 single production process owner；Gateway 运行在 supervisor 同一个 Node process 中；DSH 是 owned child process。

---

# 3. 推荐新增文件

```text
src/remote/production/
  supervisor.mjs
  credential-store.mjs
  dsh-bootstrap.mjs
  dsh-process.mjs
  production-config.mjs
  runtime-status.mjs
  control-channel.mjs
  logger.mjs
  log-rotation.mjs
  windows-acl.mjs

scripts/
  remote-production.mjs
  dsh-start.ps1
  dsh-stop.ps1
  dsh-restart.ps1
  dsh-status.ps1
  phone-token-show.ps1
  phone-token-rotate.ps1

tests/remote/
  r7-supervisor.test.mjs
  r7-credential-store.test.mjs
  r7-dsh-bootstrap.test.mjs
  r7-process-ownership.test.mjs
  r7-runtime-status.test.mjs
  r7-control-channel.test.mjs
  r7-logging.test.mjs
  r7-log-rotation.test.mjs
  r7-acl.test.mjs
  r7-production-config.test.mjs
  r7-startup-failure.test.mjs
  r7-shutdown.test.mjs
  r7-restart.test.mjs
  r7-live-smoke.test.mjs

docs/
  r7-production-operations.md
  r7-dsh-bootstrap-evidence.md
  r7-security-boundary.md
```

---

# 4. PowerShell 5.1 与编辑纪律

所有 operator scripts 必须兼容 Windows PowerShell 5.1。

允许：

```text
[System.IO.File]
[System.Security.AccessControl]
[System.Security.Principal]
Start-Process
Get-Process
Get-Acl
Set-Acl
```

继续禁止：

```powershell
Set-Content
Out-File
Add-Content
```

修改项目文件或写 runtime control/state。

写文本用：

```powershell
[System.IO.File]::WriteAllText(
    $path,
    $text,
    (New-Object System.Text.UTF8Encoding($false))
)
```

---

# 5. Production State Root

真实 root：

```text
D:\DSH-work-test\.dsh\remote
```

布局：

```text
remote/
  format.json

  secrets/
    phone-token.v1
    phone-token.meta.json

  state/
    gateway.lock
    supervisor.lock
    supervisor.json
    dsh-cursors.json
    session-views.a.json
    session-views.b.json
    control/

  events/
    ...

  logs/
    supervisor.log
    gateway.log
    dsh.log

  quarantine/
    ...
```

R5 persistence format 保持 v1，不修改 journal/snapshot schema。

---

# 6. First-Create Safety

Gate B 开始时如果真实 root 已存在，而 R7 尚未创建过：

```text
STOP
R7_PRODUCTION_ROOT_UNEXPECTED
```

不要删除、覆盖或盲目复用。

第一次创建顺序：

```text
create empty remote/
↓
protect DACL
↓
verify DACL
↓
create protected child directories
↓
only then create credential/state/log files
```

ACL 失败：

```text
R7_ACL_HARDENING_FAILED
STOP
```

---

# 7. Windows ACL Model

使用 SID，不使用本地化用户名。

允许 principals：

```text
current Windows user SID
LocalSystem S-1-5-18
```

目标：

```text
inheritance disabled
current user: FullControl
SYSTEM: FullControl
```

明确拒绝 broad Allow ACE：

```text
Everyone              S-1-1-0
Authenticated Users   S-1-5-11
BUILTIN\Users         S-1-5-32-545
```

必须检查：

```text
AreAccessRulesProtected == true
```

出现无法解释的 broad Allow ACE：

```text
R7_ACL_POLICY_MISMATCH
STOP
```

---

# 8. Secret File ACL

`secrets/phone-token.v1` 必须继承受保护目录或自身禁用 inheritance，并只允许 current SID + SYSTEM FullControl。

验证失败：

```text
R7_PHONE_TOKEN_ACL_INVALID
```

Gateway 不启动。

---

# 9. Production Phone Credential

格式：

```text
32 random bytes
base64url
no padding
43 chars
```

生成：

```js
crypto.randomBytes(32).toString('base64url')
```

使用 exclusive create，防止双 first-start race。

若 secret 已存在：

```text
load
validate format
validate ACL
```

不得 silent regenerate。

---

# 10. Credential Storage

默认：

```text
D:\DSH-work-test\.dsh\remote\secrets\phone-token.v1
```

内容只保存 token 本体，建议 no BOM / no trailing newline。

metadata：

```json
{
  "v": 1,
  "created_at": "...",
  "generation_id": "uuid"
}
```

metadata 不包含 token/hash/prefix/fingerprint。

---

# 11. Credential Logging / Reveal / Rotation

Supervisor 永不自动打印 Phone token。

首次生成只输出：

```text
Phone credential created securely.
Use phone-token-show.ps1 to reveal it explicitly.
```

`phone-token-show.ps1` 只有 operator 主动运行时才：

1. 校验 secret ACL。
2. 读取 token。
3. 输出到当前 console。
4. 不写 clipboard。
5. 不写日志。
6. 不生成 QR。

`phone-token-rotate.ps1` 要求 supervisor 停止，使用 temp secret → ACL → validate → atomic replace；不保留 old token plaintext backup。

---

# 12. Production Config

集中到 `production-config.mjs`。

关键默认：

```text
DSH_HOME = D:\DSH-work-test\.dsh
DSH_URL  = http://127.0.0.1:3080
Gateway  = 127.0.0.1:9445
DSH workspace = D:\DSH-testing
```

禁止 Gateway bind：

```text
0.0.0.0
::
LAN IP
public IP
```

---

# 13. DSH Version Pin / Launch Audit

Production DSH 固定：

```text
@deepseek-ai/dsh@0.1.5-rc.2
```

不要 `@latest`。

R0/R1 预期启动：

```text
npx -y @deepseek-ai/dsh@0.1.5-rc.2 web --no-open
```

R7 必须先重新 audit installed CLI help / package entrypoint。

如果 `--no-open` 或参数语义与证据不符：

```text
STOP
R7_DSH_LAUNCH_CONTRACT_CHANGED
```

不要猜新 flag。

Supervisor spawn：

```text
cwd = D:\DSH-testing
env.DSH_HOME = D:\DSH-work-test\.dsh
```

不要依赖 shell CWD。

---

# 14. DSH Process Ownership

Supervisor 必须持有：

```text
actual ChildProcess handle
child PID
instance_id
```

禁止：

```text
Stop-Process -Name node
taskkill /IM node.exe
kill every npx/node process
```

只能处理 owned DSH child / owned supervisor PID。

若 3080 已被未知进程占用：

```text
R7_DSH_PORT_IN_USE
STOP
```

不要 attach/kill。

---

# 15. DSH Stdout / Bootstrap

DSH stdout/stderr 必须 pipe。

禁止：

```text
raw console inherit + scrape
raw tee to disk before redaction
```

顺序必须：

```text
read in memory
↓
bootstrap parser
↓
redact
↓
optional log
```

创建 `docs/r7-dsh-bootstrap-evidence.md`，对真实 rc.2 记录：

```text
launch-token output shape
auth exchange endpoint
HTTP method
request encoding
Set-Cookie shape
cookie name/prefix
failure responses
```

真实 token/cookie 一律 `<redacted>`。

---

# 16. Launch Token Parser

Parser 必须 version-specific、strict、fail closed。

一轮启动要求 exactly one valid launch token。

如果 0 / >1 distinct / unexpected shape：

```text
R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED
STOP child
```

launch token：

```text
memory only
```

不得写 journal/snapshot/log/status/env file。

---

# 17. Auth Cookie Bootstrap

通过审计后的真实 DSH auth exchange：

```text
launch token
↓
loopback HTTP
↓
Set-Cookie: dsh-auth-...
```

cookie memory-only。

exchange 后用 cookie 调用 known read-only DSH endpoint 验证兼容性，通过后才 construct production DshAdapter。

失败：

```text
R7_DSH_AUTH_BOOTSTRAP_FAILED
```

旧 DSH child退出后旧 cookie立即视为 invalid；新 child 必须 fresh token → fresh cookie。

---

# 18. Adapter Auth Injection

新增或复用 `CookieAuthProvider`，保持 R1 wire boundary。

DSH cookie 只能在 bootstrap/adapter boundary 可见，不得传入：

```text
REST routes
Phone AuthService
Gateway events
journal
WebSocket
```

---

# 19. Supervisor Lifecycle

状态：

```text
STARTING
BOOTSTRAPPING_DSH
STARTING_GATEWAY
READY
RESTARTING
STOPPING
STOPPED
FAILED
```

写入 `state/supervisor.json`，可记录：

```text
instance_id
state
supervisor_pid
dsh_pid
started_at
gateway host/port
DSH host/port/version
last_error_code
```

不得记录任何 secret。

---

# 20. Supervisor Lock / Control

独立 `state/supervisor.lock`，语义沿用 R5 conservative lock：

```text
live/unprovable owner → refuse
provably dead → quarantine
never kill unknown owner
```

control 不新增 TCP port。

推荐：

```text
state/control/
```

请求：

```json
{
  "v": 1,
  "instance_id": "...",
  "request_id": "uuid",
  "action": "stop",
  "created_at": "..."
}
```

Supervisor 只接受 matching instance + `stop`。

stale/wrong-instance request 不得停掉新实例。

---

# 21. Operator Scripts

创建：

```text
dsh-start.ps1
dsh-stop.ps1
dsh-restart.ps1
dsh-status.ps1
phone-token-show.ps1
phone-token-rotate.ps1
```

`dsh-restart.ps1`：

```text
clean stop
wait exit
fresh start
```

不要实现复杂 hot restart。

`dsh-status.ps1` 仅显示 safe state / PID / ports / public health / last safe error code。

---

# 22. Graceful Stop

顺序：

```text
receive stop
↓
Gateway.stop()
  ├── stop WS
  ├── stop StatusService
  ├── flush persistence
  ├── release gateway lock
  └── close adapter
↓
stop owned DSH child
↓
flush logs
↓
release supervisor lock
↓
STOPPED
↓
exit
```

DSH child 优先 graceful stop；超时只允许：

```text
taskkill /PID <owned-dsh-pid> /T
```

绝不 `/IM node.exe`。

---

# 23. Unexpected DSH Exit

基本自愈：

```text
max 3 restart attempts
backoff 1s, 2s, 4s
```

每次：

```text
stop Gateway if active
drop old cookie
spawn fresh DSH
bootstrap fresh cookie
restart Gateway from durable state
```

3 次失败：

```text
state = FAILED
Gateway must not pretend READY
```

稳定 60s 后可清零 consecutive failure count。

Gate A 用 synthetic DSH child 测；Gate B 不故意 kill real DSH。

---

# 24. Production Logging

默认：

```text
remote/logs/supervisor.log
remote/logs/gateway.log
remote/logs/dsh.log
```

要求：

```text
UTF-8
no BOM
bounded
rotated
redacted before write
```

Gateway/Supervisor 优先 JSONL。

默认不记录：

```text
user message content
attachment bytes
full request URL
Authorization
Cookie
Phone token
WS ticket
DSH launch token
DSH auth cookie
```

---

# 25. DSH Log Policy

原始 DSH stdout 不得 arbitrary raw-persist。

`dsh.log` 只记录 allowlisted/sanitized operational events：

```text
startup
ready
warning/error summaries
exit code
```

未知 raw line：默认 drop；如保留必须先 redact + truncate。

---

# 26. Log Rotation

Gateway defaults：

```text
DSH_REMOTE_LOG_MAX_BYTES = 10485760
DSH_REMOTE_LOG_BACKUPS   = 5
```

即 10 MiB × 5 backups / component。

日志 ACL 继承 protected root。

log write失败：

```text
logging degraded
stack may continue
```

但绝不能 fallback 到 raw secret console output。

---

# 27. Secret Domains

必须保持四个独立 secret domain：

```text
Phone token:
  durable, protected file

WS ticket:
  ephemeral, memory only

DSH launch token:
  ephemeral, memory only

DSH auth cookie:
  ephemeral, memory only

DeepSeek provider credentials:
  DSH-owned, Gateway never reads
```

R7 仍然：

```text
DO NOT READ .credentials.yaml
```

不修改 DSH profile，不新增 vision model。

---

# 28. First Production Persistence Start

真实 Gateway 第一次启动：

```text
persistenceConfig: {}
```

因此 `%DSH_HOME%\remote` 成为 R5 production root。

启动前 ACL 必须已硬化。

Phone credential从 secret file 读取后构造 AuthService；不要通过 env/CLI传 secret。

---

# 29. Production Launcher

`scripts/remote-production.mjs`：

```text
load production config
load credential
start supervisor
```

不要将 token 放 CLI args。

---

# 30. Start Script

`dsh-start.ps1`：

```text
preflight
R5A compliance
verify no running supervisor
verify ports
prepare/harden first production root
launch Node supervisor
wait READY/FAILED
print safe summary
```

安全输出：

```text
Gateway READY
DSH READY
127.0.0.1:9445
Phone credential: stored securely
```

不打印 secret。

推荐 start timeout：

```text
60s
```

超时则 stop owned child/supervisor 并 fail：

```text
R7_START_TIMEOUT
```

---

# 31. READY 定义

Supervisor `READY` 必须同时满足：

```text
production ACL valid
Phone credential valid
persistence ready
DSH process alive
DSH cookie bootstrap verified
DshAdapter authenticated
StatusService started
Gateway bound 127.0.0.1:9445
authenticated health reports ready axes
```

仅端口打开不算 READY。

---

# 32. Live Authenticated Smoke

Gate B production start 后，读取 production Phone credential 到内存执行：

```text
GET /api/v1/health
Authorization: Bearer ...
```

必须：

```text
gateway ready
auth ready
persistence ready
DSH available/compatible
```

secret 不打印。

继续只读：

```text
GET /api/v1/sessions
```

必须 200。

若有 session：

```text
GET /sessions/:id
GET /sessions/:id/messages
POST /auth/ws-ticket
real WS connect
```

若无 session：

记录：

```text
R7_LIVE_NO_SESSION_AVAILABLE
```

这不是失败，只要 authenticated session list真实成功。

---

# 33. Live Reconciliation

对真实 existing session（如有）执行 read-only/no-op reconciliation smoke：

```text
real DSH cursor/history path works
no duplicate
checkpoint does not go backwards
```

禁止为了制造证据自动发模型 prompt。

若无 session：

```text
R7_LIVE_RECONCILIATION_NO_SESSION
```

并保留 fixture evidence。

---

# 34. No Real Prompt / Upload Smoke

默认禁止自动：

```text
send model prompt
cancel real run
upload attachment
```

避免额外 API费用和真实 attachment side effects。

---

# 35. Production Restart / Stop / Start

第一次 READY 后记录 safe state：

```text
journal highWater(s)
supervisor instance A
Phone token generation_id
```

执行 `dsh-restart.ps1`：

期望：

```text
new supervisor instance B
new DSH PID
fresh DSH bootstrap
same Phone token generation_id
same journal
sequence preserved
authenticated health ready
```

再执行 stop：

```text
9445 closed
owned 3080 closed
locks released
logs flushed
journal flushed
no owned orphan
unrelated Node processes untouched
```

再 start：

```text
same Phone token
recover R5 state
fresh DSH cookie
READY
```

---

# 36. Port Ownership

start 前重新检查：

```text
9445 available
3080 available
```

如果被未知进程占用：

```text
R7_PORT_IN_USE
STOP
```

不要 kill 占用者。

9444 可能属于 Edge CDP；R7 不使用、不停止。

---

# 37. Production Error Codes

至少：

```text
R7_PRODUCTION_ROOT_UNEXPECTED
R7_ACL_HARDENING_FAILED
R7_ACL_POLICY_MISMATCH
R7_PHONE_TOKEN_ACL_INVALID
R7_PHONE_TOKEN_INVALID
R7_DSH_LAUNCH_CONTRACT_CHANGED
R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED
R7_DSH_AUTH_BOOTSTRAP_FAILED
R7_DSH_PROCESS_EXITED
R7_PORT_IN_USE
R7_START_TIMEOUT
R7_CONTROL_REQUEST_INVALID
R7_SUPERVISOR_LOCKED
R7_PRODUCTION_SMOKE_FAILED
```

---

# 38. Log Events Allowlist

建议：

```text
supervisor_start
acl_verified
credential_created
credential_loaded
dsh_spawned
dsh_bootstrap_token_observed
dsh_auth_cookie_obtained
dsh_ready
gateway_starting
gateway_ready
reconciliation_complete
restart_scheduled
stop_requested
shutdown_complete
error
```

token/cookie observed只记录事件，不记录值。

---

# 39. Secret Scan

production smoke 后：

允许 Phone token仅出现：

```text
secrets/phone-token.v1
```

除此之外所有文件必须：

```text
NO Phone token
NO launch token
NO dsh-auth cookie
NO WS ticket
```

尤其：

```text
logs
events
state
metadata
```

Phone token digest也不要写 metadata/log。

---

# 40. Operator / Security Docs

`docs/r7-production-operations.md` 必须说明：

```text
first start
normal start
status
stop
restart
show Phone token
rotate Phone token
log locations
journal locations
what not to delete
FAILED recovery
port in use
stale lock
```

`docs/r7-security-boundary.md` 必须区分四类 secret。

`docs/r7-dsh-bootstrap-evidence.md` 必须记录真实 rc.2 bootstrap contract，真实值全部 redacted。

---

# 41. Production Preflight

`dsh-start.ps1` 最低检查：

```text
PowerShell 5.1 compatible
Node available
npm/npx available
DSH package version
project files present
R5A compliance PASS
9445 free
3080 free or known-owned
production root status
ACL capability
supervisor lock
```

第一次 root 创建前所有 non-mutating prechecks必须通过。

不要修改现有：

```text
D:\DSH-work-test\启动DSH.bat
D:\DSH-work-test\启动DSH.ps1
```

并在文档注明不要与 production supervisor 同时运行。

---

# 42. R7 Tests

至少：

```text
r7-production-config.test.mjs
r7-credential-store.test.mjs
r7-acl.test.mjs
r7-dsh-bootstrap.test.mjs
r7-process-ownership.test.mjs
r7-runtime-status.test.mjs
r7-control-channel.test.mjs
r7-logging.test.mjs
r7-log-rotation.test.mjs
r7-supervisor.test.mjs
r7-startup-failure.test.mjs
r7-shutdown.test.mjs
r7-restart.test.mjs
r7-live-smoke.test.mjs
```

覆盖：

```text
credential create/load/race/rotation
ACL policy
strict launch-token parser
cookie bootstrap fixture
unrelated Node survives
control instance binding
log rotation/redaction
supervisor state machine
1/2/4 restart backoff
3-failure cap
clean shutdown
restart
startup refusal
```

---

# 43. Raw DSH Output Test

fixture DSH 输出：

```text
ready at http://127.0.0.1:3080/?token=LAUNCH_TOKEN_SECRET
```

最终 console/log必须：

```text
not contain LAUNCH_TOKEN_SECRET
```

这是 R7 核心日志测试。

---

# 44. Gate A Regression

Gate A 完成后：

```text
R1  82 / 82
R2 113 / 113
R3 161 / 161
R4 132 / 132
R5 155 / 155
R5A 12 / 12
R6 168 / 168
R7 new tests green
```

full suite连续 3 次 clean。

此时 real production root仍必须不存在。

然后：

```text
npm run compliance:r5a
```

必须 PASS。

---

# 45. External Regression / Protected Hashes / Encoding

外部：

```text
planner declared: 327 / 0
planner full:     676 / 9 same
codex declared:   175 / 0
codex full:       220 / 219 / 1 same
```

protected：

```text
13 / 13
```

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

project encoding：

```text
BOM = 0
U+FFFD = 0
invalid UTF-8 = 0
```

production JSON/log也必须 UTF-8 no BOM。

---

# 46. Known Limitations

R7 报告必须明确：

```text
1. server still loopback-only
2. no SSH/Tailscale yet
3. no Mobile UI yet
4. Phone token single-principal only
5. no automatic OS startup/service install
6. no malware scanner
7. DSH launch-token parser is version-specific to rc.2
8. DSH cookie is process-lifetime bootstrap state
9. power-loss durability remains R5 semantics
10. raw DSH stdout is intentionally not fully persisted
11. live reconciliation may be no-op if no real sessions exist
12. no automatic production prompt generation
```

R7 不安装 Windows Service / Task Scheduler / startup shortcut。

---

# 47. R7 Definition of Done

## Gate A

- [ ] R6 baseline green
- [ ] R5A compliance PASS
- [ ] real production root absent
- [ ] supervisor implemented
- [ ] credential store fixture-tested
- [ ] Windows ACL temp-root tested
- [ ] DSH bootstrap fixture-tested
- [ ] cookie bootstrap fixture-tested
- [ ] process ownership tested
- [ ] control channel tested
- [ ] logging/redaction tested
- [ ] rotation tested
- [ ] R7 tests green
- [ ] full suite 3× green
- [ ] external regressions unchanged
- [ ] protected hashes 13/13
- [ ] encoding clean

## Gate B

- [ ] real production root intentionally created
- [ ] root ACL hardened before secret/data
- [ ] Phone credential securely created/loaded
- [ ] token ACL verified
- [ ] real DSH rc.2 spawned and owned
- [ ] exact launch contract audited
- [ ] launch token memory-only
- [ ] auth cookie memory-only
- [ ] real DshAdapter authenticated
- [ ] persistence initialized real root
- [ ] Gateway READY on loopback 9445
- [ ] authenticated health passes
- [ ] real session listing passes
- [ ] WS smoke passes if session exists
- [ ] reconciliation smoke passes/no-op safely
- [ ] production restart smoke passes
- [ ] production stop/start lifecycle passes
- [ ] unrelated Node process untouched
- [ ] production secret scan passes
- [ ] logs redacted
- [ ] locks released correctly

## Scope

- [ ] no R8 UI
- [ ] no R9 transport
- [ ] no firewall changes
- [ ] no sshd enable
- [ ] no Tailscale
- [ ] no DSH profile changes
- [ ] no `.credentials.yaml` read
- [ ] R8 not started

---

# 48. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R7-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R6 baseline
3. Gate A / Gate B model
4. Scope completed
5. Files created
6. Files modified
7. Production architecture
8. Production root creation
9. Windows ACL policy
10. ACL evidence
11. Phone credential generation
12. Credential storage/reveal/rotation
13. Production config
14. DSH version/launch audit
15. DSH process ownership
16. Launch-token parsing
17. DSH auth-cookie exchange
18. Adapter auth injection
19. Supervisor lifecycle
20. Supervisor lock/status
21. Control channel
22. Start/stop/restart scripts
23. Auto-restart policy
24. Disk logging
25. Log rotation
26. Redaction evidence
27. Secret-domain separation
28. First production persistence start
29. Live authenticated health smoke
30. Live sessions smoke
31. Live WebSocket smoke
32. Live reconciliation smoke
33. Production restart smoke
34. Production stop/start smoke
35. Port/process ownership
36. Gate A test results
37. R1-R6 regression
38. External regression
39. Protected hashes
40. R5A compliance
41. Encoding/process gate
42. Production secret scan
43. Security review
44. Known limitations
45. Deferred R8/R9
46. R8 readiness
47. Exact stop statement
```

---

# 49. 报告必须逐项回答

1. Gate A 前 real `$DSH_HOME\remote` 是否存在？
2. Gate B 中何时创建 real root？
3. ACL 是否在写 secret/data 前完成？
4. root allowed SIDs？
5. broad Users/Everyone/Authenticated Users 是否有 Allow ACE？
6. inheritance 是否 disabled？
7. Phone token格式/entropy？
8. 是否自动打印？
9. 存在哪里？
10. token ACL是否验证？
11. 是否通过 env/CLI传 token？
12. rotation是否保留旧 token？
13. reveal是否只有显式调用输出？
14. DSH exact version？
15. DSH start command？
16. `--no-open` 是否重新审计？
17. supervisor cwd？
18. DSH_HOME？
19. 是否 attach/kill未知 3080 owner？
20. 是否使用 process-name kill？
21. launch token从哪里观察？
22. 是否写 disk？
23. parser如何防误匹配？
24. auth exchange endpoint/method？
25. dsh cookie是否写 disk？
26. cookie如何验证？
27. DshAdapter是否真实 authenticated？
28. `.credentials.yaml` 是否读取？
29. DSH profile是否修改？
30. supervisor states？
31. lock如何防双实例？
32. control channel是否新增TCP端口？
33. stale stop request如何处理？
34. stop顺序？
35. child不退出fallback？
36. unexpected DSH exit重试策略？
37. max retries后状态？
38. logs在哪里？
39. raw DSH stdout是否直接落盘？
40. log rotate默认？
41. Phone token是否出现在logs？
42. launch token是否出现在logs？
43. dsh cookie是否出现在logs？
44. Phone token在real root哪些文件允许出现？
45. authenticated health是否真实通过？
46. real session list是否通过？
47. real WS smoke是否通过/为何未执行？
48. live reconciliation是否通过/no-op？
49. restart后Phone token是否相同？
50. restart后DSH cookie是否重新bootstrap？
51. journal/sequence是否保持？
52. stop后3080/9445是否关闭？
53. unrelated Node process是否存活？
54. R1-R6是否全绿？
55. R7新测试数量？
56. full suite clean几次？
57. external regression是否新增fail？
58. protected hashes 13/13？
59. R5A compliance PASS？
60. encoding scan？
61. 是否使用 forbidden PowerShell text cmdlet？
62. 是否启用 sshd？
63. 是否安装/配置 Tailscale？
64. 是否修改 firewall？
65. 是否创建 R8 UI？
66. 是否进入 R8？

---

# 50. Stop Gate

完成 R7 后：

```text
R7 COMPLETE — STOPPING HERE.
```

不得：

```text
enable sshd
install/configure Tailscale
open firewall
bind Gateway to LAN
create Mobile UI
serve static chat UI
generate QR pairing page
```

不得进入 R8。

---

# 51. 给 DSH 的执行指令

现在执行：

```text
Phase R7 — Production Supervisor, Credential Bootstrap & Live DSH Integration
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R6-REPORT.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R5A-REPORT.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R5-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r6-security-model.md
D:\DSH-testing\dsh-remote-gateway\docs\r6-auth-contract.md
D:\DSH-testing\dsh-remote-gateway\docs\r5-persistence-design.md
```

## Gate A

1. `npm run compliance:r5a` → PASS。
2. `npm test` → 823/823 baseline。
3. 确认 real `$DSH_HOME\remote` 不存在。
4. 写 R7 production/security/bootstrap docs。
5. 实现 production config。
6. 实现 credential store（temp-root tests）。
7. 实现 Windows ACL helper（temp-root真实ACL test）。
8. 实现 DSH process wrapper。
9. 实现严格 launch-token parser。
10. 实现 synthetic cookie bootstrap。
11. 实现 production adapter auth provider。
12. 实现 supervisor / status / control channel。
13. 实现 safe logger + rotation。
14. 实现 PS5.1 start/stop/restart/status/reveal/rotate scripts。
15. 完成 R7 Gate A tests。
16. full suite连续3次。
17. external regression。
18. protected hashes。
19. R5A compliance PASS。
20. encoding scan。
21. real `$DSH_HOME\remote` 仍必须不存在。

任何 Gate A 失败：STOP，不得进入 Gate B。

## Gate B

22. 再次确认 3080/9445 ownership/availability。
23. audit真实 DSH rc.2 launch contract。
24. 创建 empty real `$DSH_HOME\remote`。
25. 立即应用并验证 Windows ACL。
26. 创建 protected child dirs。
27. exclusive-create production Phone token。
28. 验证 token ACL；不打印 token。
29. spawn owned DSH。
30. 捕获 launch token in memory。
31. 用审计后的 exchange换 dsh-auth cookie。
32. 验证 cookie。
33. construct real DshAdapter。
34. first real persistence initialize。
35. start Gateway on `127.0.0.1:9445`。
36. authenticated health smoke。
37. real session-list smoke。
38. 如有真实session，WS/reconciliation read-only smoke。
39. production secret scan。
40. production restart smoke。
41. production stop/start smoke。
42. 验证 unrelated Node process未被影响。
43. 验证 logs/rotation/redaction。
44. 生成 `PHASE-R7-REPORT.md`。
45. STOP。
46. 不进入 R8。

如果 launch-token输出/交换协议无法被真实证据解析：

```text
STOP
R7_DSH_BOOTSTRAP_CONTRACT_UNRESOLVED
```

如果无法在不落盘 secret 的情况下完成 bootstrap：

```text
STOP
R7_DSH_SECRET_BOUNDARY_UNRESOLVED
```

如果 Windows ACL 无法验证成预期策略：

```text
STOP
R7_ACL_POLICY_UNRESOLVED
```

如果 production root 在 Gate B 前意外出现：

```text
STOP
R7_PRODUCTION_ROOT_TOUCHED_EARLY
```

如果使用 `Set-Content / Out-File / Add-Content` 修改项目文件：

```text
STOP
R7_PROCESS_VIOLATION
```
