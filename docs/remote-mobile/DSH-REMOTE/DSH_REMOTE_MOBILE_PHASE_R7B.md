# Phase R7B — External Gate B Completion & Production Acceptance

> 项目：`D:\DSH-testing\dsh-remote-gateway`
>
> 前置状态：
>
> - R7 Gate A：COMPLETE
> - R7 Gate B：PARTIAL
> - R7 overall：`R7 PARTIAL — STOPPING HERE.`
> - R8：未开始
>
> 本阶段唯一目标：
>
> **在普通 Windows PowerShell 5.1、且不处于当前 DSH/agent Windows Job Object 内的外部控制台中，完成 R7 Gate B 的真实 production 验证。**
>
> 本阶段不是 R8，不新增产品功能。

---

## 1. 当前验收结论

R7 暂不能进入 R8，原因不是 Gate A 失败，而是以下真实 production path 尚未 live 验证：

```text
real DSH spawn ownership
launch-token → dsh-auth cookie
real DshAdapter authentication
real persistence initialization
Gateway READY
authenticated health
real session list
real WS path
live reconciliation
restart
stop / start lifecycle
lock release
```

R7 已确认当前 agent session 位于 DSH Windows Job/process tree 中；从该环境再次 spawn DSH child 会导致 harness 退出，因此 Gate B 必须移到外部普通 PowerShell。

同时 R7 已确认：

```text
dsh web --port 3081
```

可以运行，因此 R7B 使用 3081，**不触碰当前交互 DSH 的 3080**。

---

## 2. 必须永久保留的历史记录

R7 曾触发：

```text
R7_PRODUCTION_ROOT_TOUCHED_EARLY
```

原因是 Gate A 早期测试错误继承真实 `DSH_HOME`，提前创建了真实：

```text
D:\DSH-work-test\.dsh\remote
```

该 residue 无 Phone credential、events 为空，证据已保存，根因已修复。

R7B 不得删除或弱化这条历史。

即使 R7B PASS，最终只能写：

```text
R7 production acceptance passed,
with R7_PRODUCTION_ROOT_TOUCHED_EARLY retained in the audit record.
```

不得写：

```text
R7 was fully compliant from the beginning.
```

---

## 3. 当前基线

```text
R1:    82 / 82
R2:   113 / 113
R3:   161 / 161
R4:   132 / 132
R5:   155 / 155
R5A:   12 / 12
R6:   168 / 168

R7:
204 total
195 pass
0 fail
9 live-smoke skip

Full:
1027 total
1018 pass
0 fail
9 skip
```

外部 baseline：

```text
planner declared: 327 / 0
planner full:     676 / 9 same cases
codex declared:   175 / 0
codex full:       220 / 219 / 1 same case
protected hashes: 13 / 13
```

---

## 4. 执行环境要求

必须使用：

```text
普通 Windows PowerShell 5.1
```

禁止在：

```text
当前 DSH agent session
Codex/DSH embedded shell
受 DSH Windows Job Object 管理的 runner
```

内执行真实 Gate B。

---

## 5. 端口策略

保持：

```text
current interactive DSH = 127.0.0.1:3080
R7B owned DSH           = 127.0.0.1:3081
Gateway                 = 127.0.0.1:9445
```

R7B 不得：

```text
stop 3080
attach 3080
kill 3080 owner
modify existing interactive launcher
```

3081 或 9445 被未知进程占用时：

```text
STOP
```

不得 kill owner。

---

## 6. 直接执行命令

在普通 PowerShell：

```powershell
cd D:\DSH-testing\dsh-remote-gateway
node scripts\r7-gate-b.mjs --dsh-port 3081 --no-restore
```

该命令是当前 R7 报告已经指定的外部 Gate B completion path。

---

## 7. Preflight

执行前确认：

```text
PowerShell 5.1
Node v24.20.0
npm / npx available
DSH pinned @deepseek-ai/dsh@0.1.5-rc.2
project path correct
production root exists
root ACL valid
Phone credential exists
Phone credential ACL valid
3081 free
9445 free
3080 remains operator-owned and untouched
```

先运行：

```powershell
npm run compliance:r5a
```

必须 PASS。

注意：

R7 已将该 gate 改为 phase-aware，使合法 production root existence 不再算失败。R7B 报告必须明确这一点，不得把它描述为“原始 R5A gate 完全未修改”。

---

## 8. Production root 规则

当前合法 production root 已存在：

```text
D:\DSH-work-test\.dsh\remote
```

R7B：

```text
DO NOT delete
DO NOT recreate
DO NOT reset
DO NOT rotate Phone token automatically
```

必须复用：

```text
format.json
ACL
Phone credential
generation_id
journal/snapshot/cursor
```

---

## 9. Phone credential

开始前记录：

```text
generation_id_before
```

不得记录 plaintext token。

R7B 默认必须复用 existing production Phone token。

restart 后必须：

```text
generation_id_after == generation_id_before
```

---

## 10. DSH launch contract

固定版本：

```text
@deepseek-ai/dsh@0.1.5-rc.2
```

真实启动逻辑：

```text
node <npm>\bin\npx-cli.js
-y @deepseek-ai/dsh@0.1.5-rc.2
web
--no-open
--port 3081
```

不得使用 `@latest`。

---

## 11. Launch token 验证

真实 stdout 预期：

```text
dsh web: http://127.0.0.1:3081/?token=<redacted>
```

parser 必须：

```text
anchor on "dsh web:"
extract FIRST token query from authoritative URL
require 43-char base64url
reject 0 token
reject >1 distinct token
reject malformed token
```

LAN suffix 若存在，不得误判成第二个不同 token。

launch token：

```text
memory only
```

不得出现在：

```text
logs
state
events
secrets
supervisor.json
evidence
console transcript
```

---

## 12. Real dsh-auth cookie exchange

使用真实 launch token：

```text
GET http://127.0.0.1:3081/?token=<launch-token>
Host: 127.0.0.1:3081
```

成功必须同时满足：

```text
HTTP 303
Set-Cookie begins with dsh-auth-
```

只有 303 不算成功。

cookie：

```text
memory only
```

---

## 13. Cookie verification

使用 cookie 调真实 read-only DSH endpoint：

```text
POST /api/session/modelCatalog
```

要求：

```text
not 401
not 403
authenticated response
```

成功后才允许：

```text
construct real DshAdapter
```

如果真实 contract 与已审计 rc.2 不符：

```text
STOP
R7_DSH_LAUNCH_CONTRACT_CHANGED
```

---

## 14. Real DshAdapter

必须证明：

```text
real cookie provider wired
real DSH request authenticated
Phone token not forwarded
launch token not forwarded
```

R7B 报告必须明确：

```text
real DshAdapter authenticated: YES
```

否则 Gate B FAIL。

---

## 15. Real persistence initialization

在现有：

```text
D:\DSH-work-test\.dsh\remote
```

上完成真实 initialization：

```text
format v1 validated
writer lock acquired
journal recovery succeeds
snapshot recovery succeeds
DSH cursor state valid
```

不得 reset/truncate/delete durable state。

---

## 16. Gateway READY

真实 Gateway：

```text
127.0.0.1:9445
```

READY 必须同时满足：

```text
ACL valid
Phone credential valid
persistence ready
DSH child alive
cookie bootstrap verified
real DshAdapter authenticated
StatusService started
Gateway bound 9445
authenticated health ready
```

“9445 listening”本身不能算 READY。

---

## 17. Authenticated health smoke

使用 Phone token，仅保存在内存：

```http
GET /api/v1/health
Authorization: Bearer <PHONE_TOKEN>
```

必须：

```text
200
gateway ready
auth ready
persistence ready
DSH ready/compatible
```

不得把 Authorization header 或 token 写入 evidence。

---

## 18. Real sessions smoke

执行：

```http
GET /api/v1/sessions
Authorization: Bearer <PHONE_TOKEN>
```

必须：

```text
200
```

即使：

```text
session_count = 0
```

也算 real Adapter/auth path成功。

如果无 session，记录：

```text
R7_LIVE_NO_SESSION_AVAILABLE
```

---

## 19. WS smoke

仅在 real session 存在时执行：

```text
POST /api/v1/auth/ws-ticket
→ one-time ticket
→ WS /api/v1/events
→ 101
→ hello
→ replay_complete and/or event
```

然后 reuse ticket：

```text
must be rejected
```

长期 Phone Bearer不得进入 URL。

如果无 real session：

```text
WS live smoke:
NOT APPLICABLE — no real DSH session available
```

这是合法 N/A。

---

## 20. Live reconciliation

有 real session 时：

```text
read-only reconciliation
cursor/history path works
checkpoint never moves backward
no duplicate source events
no fabricated assistant.delta
```

无 session：

```text
R7_LIVE_RECONCILIATION_NO_SESSION
```

合法 N/A。

R7B 不得为了造证据：

```text
send model prompt
cancel task
upload file
create fake session
```

---

## 21. Production secret scan

唯一允许 Phone token存在：

```text
remote\secrets\phone-token.v1
```

其余所有文件必须：

```text
Phone token absent
launch token absent
dsh-auth cookie absent
WS ticket absent
Phone token digest absent
```

至少扫描：

```text
logs/
events/
state/
metadata
format.json
```

---

## 22. Logging 验证

检查：

```text
logs\supervisor.log
logs\gateway.log
logs\dsh.log
```

必须：

```text
UTF-8
no BOM
redacted
bounded
allowlisted events only
```

禁止出现：

```text
Phone token
launch token
dsh-auth cookie
WS ticket
Authorization
raw authenticated DSH URL
```

真实：

```text
dsh web: ...?token=<secret>
```

不得原样落盘。

---

## 23. Restart smoke

第一次 READY 后记录 safe metadata：

```text
Phone generation_id
journal highWater
supervisor instance A
DSH PID A
```

执行 clean restart。

要求：

```text
supervisor instance B != A
DSH PID B != A
Phone generation_id unchanged
fresh DSH bootstrap
old cookie discarded
new cookie obtained
journal preserved
sequence does not reset
authenticated health ready
```

不得比较或记录 cookie plaintext/hash。

---

## 24. Stop smoke

执行 clean stop。

要求：

```text
9445 closed
3081 owned DSH closed
3080 still alive/untouched
Gateway lock released
supervisor lock released
logs flushed
journal flushed
no owned orphan
```

禁止 process-name kill。

---

## 25. Start again

再次 start：

```text
same Phone generation_id
existing journal recovered
new DSH PID
fresh cookie bootstrap
Gateway READY
authenticated health ready
```

推荐最终：

```text
clean STOP
```

便于验收。

---

## 26. Final port state

推荐最终：

```text
9445 closed
3081 closed
3080 unchanged
```

如果最终保留 READY，必须明确记录：

```text
FINAL STATE = READY
supervisor PID
DSH PID
9445 listening
3081 listening
```

---

## 27. Process and encoding gate

继续禁止：

```powershell
Set-Content
Out-File
Add-Content
```

修改 project/runtime text。

最终：

```text
BOM = 0
U+FFFD = 0
invalid UTF-8 = 0
```

若发生 forbidden cmdlet：

```text
R7B_PROCESS_VIOLATION
STOP
```

---

## 28. `.credentials.yaml` 与 DSH profile

继续：

```text
DO NOT OPEN .credentials.yaml
DO NOT HASH its content
DO NOT COPY it
DO NOT PARSE it
```

Gateway/supervisor只使用：

```text
launch token
dsh-auth cookie
```

不修改：

```text
DSH profile
model
provider
reasoning level
vision configuration
```

---

## 29. 不得进入 R8 / R9

R7B 禁止：

```text
Mobile UI
HTML/CSS/JS chat page
PWA
QR pairing page
static asset serving
enable sshd
install/configure Tailscale
firewall rule
LAN bind
TLS listener
```

---

## 30. Regression

R7B结束前：

```powershell
npm test
```

必须：

```text
0 fail
```

自动 tests 与 live evidence必须分开报告。

重新验证 external baselines：

```text
327 / 0
676 / 9 same cases
175 / 0
220 / 219 / 1 same case
```

Protected hashes：

```text
13 / 13
```

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

## 31. Evidence

至少生成：

```text
D:\DSH-testing\docs\remote-mobile\_evidence\r7b-gate-b-result.json
D:\DSH-testing\docs\remote-mobile\_evidence\r7b-gate-b-console.txt
D:\DSH-testing\docs\remote-mobile\_evidence\r7b-secret-scan.json
D:\DSH-testing\docs\remote-mobile\_evidence\r7b-port-process-state.json
```

所有 evidence必须 redacted。

不得含：

```text
Phone token
launch token
cookie
ticket
Authorization
```

---

## 32. 建议 result JSON

```json
{
  "phase": "R7B",
  "dsh_port": 3081,
  "gateway_port": 9445,
  "dsh_spawn_owned": true,
  "launch_token_observed": true,
  "cookie_exchange": true,
  "cookie_verified": true,
  "adapter_authenticated": true,
  "persistence_ready": true,
  "gateway_ready": true,
  "health_authenticated": true,
  "sessions_status": 200,
  "session_count": 0,
  "ws_smoke": "not_applicable_no_session",
  "reconciliation": "not_applicable_no_session",
  "restart_smoke": true,
  "stop_start_smoke": true,
  "phone_generation_preserved": true,
  "secret_scan": true,
  "locks_released": true,
  "interactive_3080_untouched": true,
  "final_state": "STOPPED"
}
```

---

## 33. PASS 条件

全部 mandatory 项必须满足：

- [ ] 外部普通 PowerShell执行。
- [ ] 3081由 supervisor-owned DSH占用。
- [ ] 3080始终 untouched。
- [ ] launch token真实捕获。
- [ ] launch token未落盘。
- [ ] 303 + dsh-auth cookie真实获得。
- [ ] cookie真实验证。
- [ ] cookie未落盘。
- [ ] real DshAdapter authenticated。
- [ ] real persistence ready。
- [ ] Gateway真实READY。
- [ ] authenticated health 200。
- [ ] real sessions endpoint 200。
- [ ] 有session时WS pass；无session合法N/A。
- [ ] 有session时reconciliation pass；无session合法N/A。
- [ ] restart smoke pass。
- [ ] stop/start smoke pass。
- [ ] Phone generation_id保持。
- [ ] journal/sequence保持。
- [ ] secret scan clean。
- [ ] logs redacted。
- [ ] locks release。
- [ ] unrelated 3080/Node untouched。
- [ ] automated suite 0 fail。
- [ ] external baselines unchanged。
- [ ] protected hashes 13/13。
- [ ] encoding clean。
- [ ] no forbidden PowerShell cmdlet。
- [ ] no `.credentials.yaml` read。
- [ ] no R8/R9 work。

---

## 34. 允许的 N/A

只有：

```text
WS live smoke
live reconciliation
```

允许在：

```text
GET /api/v1/sessions = 200
session_count = 0
```

时记录 N/A。

以下绝不能写 N/A：

```text
DSH spawn
cookie exchange
cookie verify
adapter auth
persistence
Gateway READY
health
sessions endpoint
restart
stop/start
```

---

## 35. FAIL 条件

任一即 FAIL：

```text
external console仍无法spawn owned DSH
launch token未观察到
cookie exchange失败
cookie verify失败
real DshAdapter未认证
real persistence失败
Gateway无法READY
authenticated health失败
sessions endpoint失败
restart失败
stop/start失败
3080受到影响
secret泄漏
ACL失效
journal损坏
sequence reset
未知进程被kill
forbidden PowerShell cmdlet
.credentials.yaml被读取
进入R8/R9
```

---

## 36. Required Report

生成：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R7B-REPORT.md
```

必须包含：

```text
1. Executive summary
2. Why R7B was required
3. R7 historical incident retained
4. External execution environment
5. Preflight
6. Port ownership before
7. Production root validation
8. Phone generation before
9. Real DSH spawn
10. Launch-token capture
11. Cookie exchange
12. Cookie verification
13. Real DshAdapter authentication
14. Real persistence initialization
15. Gateway READY
16. Authenticated health
17. Sessions smoke
18. WS smoke
19. Reconciliation smoke
20. Secret scan
21. Log/redaction review
22. Restart smoke
23. Stop smoke
24. Start-again smoke
25. Phone credential persistence
26. Journal/sequence persistence
27. Locks/control lifecycle
28. Interactive 3080 preservation
29. Process ownership
30. Final port state
31. Automated regression
32. External regression
33. Protected hashes
34. Encoding/process gate
35. Scope review
36. Remaining limitations
37. R8 readiness
38. Exact final acceptance statement
```

---

## 37. Report Questions

必须回答：

1. 是否从普通 PowerShell / 非 DSH Job Object执行？
2. 3081/9445启动前是否free？
3. 3080是否始终 untouched？
4. production root是否复用而非重建？
5. ACL是否仍有效？
6. Phone generation_id before/after？
7. 是否生成了新 Phone token？
8. real DSH是否被 supervisor spawn并owned？
9. real DSH PID？
10. launch token是否真实观察且未落盘？
11. exchange status？
12. 是否真实获得 dsh-auth cookie且未落盘？
13. cookie verify是否成功？
14. real DshAdapter是否 authenticated？
15. persistence是否真实ready？
16. Gateway是否真实READY？
17. authenticated health是否200？
18. `/sessions`是否200？
19. session count？
20. WS smoke结果？
21. reconciliation结果？
22. secret scan是否clean？
23. logs是否含任何 secret？
24. restart后 supervisor instance / DSH PID是否变化？
25. restart后 Phone generation_id是否保持？
26. restart后是否fresh bootstrap？
27. journal/sequence是否保持？
28. stop后9445/3081是否closed？
29. 3080是否仍alive？
30. locks是否release？
31. unrelated Node是否untouched？
32. start-again是否READY？
33. final state？
34. automated suite是否0 fail？
35. external baselines是否unchanged？
36. protected hashes是否13/13？
37. encoding scan？
38. forbidden PowerShell cmdlet是否0？
39. `.credentials.yaml`是否未读？
40. DSH profile是否未改？
41. R8/R9是否未开始？
42. `R7_PRODUCTION_ROOT_TOUCHED_EARLY`历史是否保留？

---

## 38. Final Acceptance

### PASS

若全部 mandatory 项通过：

```text
R7B COMPLETE — EXTERNAL GATE B PRODUCTION ACCEPTANCE PASSED.
```

并写：

```text
R7 Gate A:
  accepted

R7 Gate B:
  accepted through external production execution

R7 overall:
  COMPLETE

Historical audit:
  R7_PRODUCTION_ROOT_TOUCHED_EARLY retained permanently

Progression:
  R8 may now begin, subject to human acceptance.
```

同时把主 `PHASE-R7-REPORT.md` 的 stop statement 更新为：

```text
R7 COMPLETE — STOPPING HERE.
```

但绝不能删除历史 incident section。

### FAIL

任一 mandatory 项失败：

```text
R7B FAILED — GATE B PRODUCTION ACCEPTANCE NOT COMPLETE.
```

主 R7 保持：

```text
R7 PARTIAL
```

不得进入 R8。

---

## 39. DSH / Operator 直接执行步骤

在普通 Windows PowerShell 5.1：

```powershell
cd D:\DSH-testing\dsh-remote-gateway
```

### Step 1

```powershell
npm run compliance:r5a
```

必须 PASS。

确认端口：

```powershell
netstat -ano | findstr ":3081"
netstat -ano | findstr ":9445"
```

都必须 free。

**不要停止 3080。**

### Step 2

```powershell
node scripts\r7-gate-b.mjs --dsh-port 3081 --no-restore
```

### Step 3

检查：

```text
_evidence\r7-gate-b-result.json
```

必须覆盖：

```text
dsh_spawn_owned
launch_token_observed
cookie_exchange
cookie_verified
adapter_authenticated
persistence_ready
gateway_ready
health_authenticated
sessions_status
restart_smoke
stop_start_smoke
secret_scan
locks_released
interactive_3080_untouched
```

### Step 4

运行 production secret scan。

### Step 5

```powershell
npm test
```

必须 0 fail。

然后执行既有：

```text
external regression
protected hashes
encoding scan
```

### Step 6

生成：

```text
PHASE-R7B-REPORT.md
```

若 PASS，再更新主 R7 report 为 COMPLETE，但保留全部历史事故记录。

### Step 7

```text
STOP
```

不要进入 R8。

---

## 40. Exact Stop Gate

PASS：

```text
R7B COMPLETE — STOPPING HERE.
```

FAIL：

```text
R7B FAILED — STOPPING HERE.
```

两种情况下都禁止：

```text
R8 UI
SSH
Tailscale
firewall change
LAN bind
TLS listener
```
