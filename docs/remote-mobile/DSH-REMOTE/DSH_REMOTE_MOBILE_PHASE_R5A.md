# Phase R5A — Compliance Remediation & Acceptance Gate

> 前置阶段：Phase R5 — Durable Event Journal, Recovery & Cross-Restart Replay
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段性质：
>
> **R5A 不是新功能阶段。**
>
> 它只用于关闭 R5 自报的两个 process violations，并给出一个可审计的 clean acceptance run。
>
> **R6 在 R5A 完成并经人工验收前不得开始。**

---

# 0. 为什么需要 R5A

R5 的实现测试通过，但 R5 报告明确记录：

```text
R5_PROCESS_VIOLATION
implementation tests passed but process gate violated
```

两个违反项：

```text
1. 三次使用禁止的 PowerShell Set-Content 修改项目文件
2. automated tests 曾创建真实 D:\DSH-work-test\.dsh\remote
```

因此：

```text
R5 implementation status:
TECHNICALLY ACCEPTABLE

R5 phase-compliance status:
NOT ACCEPTED

next:
R5A clean remediation/acceptance run
```

R5A 不试图“抹掉历史”。

它要证明：

```text
the violations are now structurally prevented
and do not recur in a clean run
```

---

# 1. R5A 范围

允许：

```text
test-harness hardening
acceptance guards
verification scripts
documentation
clean reruns
evidence capture
```

禁止：

```text
new persistence feature
new API
new WebSocket frame
new auth
new supervisor
new UI
new SSH/Tailscale work
format v2
journal migration
```

如果发现真正 product defect：

```text
STOP
```

先报告，不得把 remediation 悄悄扩展成 R6/R5.1。

---

# 2. R5 基线保持

R5 当前技术基线：

```text
R1:  82 / 82
R2: 113 / 113
R3: 161 / 161
R4: 132 / 132
R5: 155 / 155

Total:
643 / 643
```

外部：

```text
planner declared: 327 / 0
planner full:     676 / 9 same cases
codex declared:   175 / 0
codex full:       220 / 219 / 1 same case

protected hashes:
13 / 13
```

R5A 不允许重新 baseline。

---

# 3. Violation A — PowerShell Source Editing

R5 已明确禁止：

```powershell
Set-Content
Out-File
Add-Content
```

修改项目：

```text
*.mjs
*.js
*.json
*.md
```

R5A 继续这一规则，并将它升级为验收条件：

```text
R5A acceptance run 中不得出现任何上述 source edit
```

即使：

```text
file ultimately correct
BOM removed
tests green
```

也视为：

```text
R5A_PROCESS_VIOLATION
```

并立即停止，不得宣布 R5A 通过。

---

# 4. 允许的编辑工具

仅允许：

```text
file-edit / patch tooling
Node fs APIs with explicit encoding
```

Node 写文本必须：

```js
fs.writeFileSync(path, text, 'utf8')
```

或等价显式 UTF-8。

不得使用默认/隐式 shell encoding。

---

# 5. Violation B — Real DSH_HOME Test Write

R5 曾让 automated tests 创建：

```text
D:\DSH-work-test\.dsh\remote
```

R5A 必须把：

```text
real DSH_HOME never touched by tests
```

从“测试约定”升级成：

```text
acceptance invariant
```

---

# 6. Real Root Precondition

R5A 开始前检查：

```text
D:\DSH-work-test\.dsh\remote
```

必须：

```text
NOT EXISTS
```

如果存在：

不要删除。

STOP 并输出：

```text
R5A_REAL_STATE_ROOT_PREEXISTS
```

记录：

```text
path
metadata only
do not inspect contents
```

等待人工决定。

R5A 不应误删未来真实 production state。

---

# 7. Real Root Postcondition

所有：

```text
R5 tests
full project tests
fixture scripts
acceptance scripts
```

完成后再次检查：

```text
D:\DSH-work-test\.dsh\remote
```

必须仍：

```text
NOT EXISTS
```

否则：

```text
R5A_REAL_STATE_ROOT_TOUCHED
```

立即失败。

不得自动清理后继续声称通过。

**这是与 R5 最大的区别：**

R5 发生后清理了。

R5A 如果再次发生：

```text
fail first
do not hide by cleanup
```

---

# 8. Test Root Guard Audit

重新审计并测试：

```text
makeTempStateRoot()
assertTempStateRoot()
fixture server defaults
server test constructors
R3 helper
R4 helper
R5 helper
```

必须证明：

```text
all automated persistence tests explicitly opt into temp root
```

不得依赖：

```text
developer remembers to pass stateRoot
```

默认 test construction 必须安全。

---

# 9. Poisoned-Environment Test

增加或确认一个测试：

环境模拟：

```text
DSH_HOME = D:\DSH-work-test\.dsh
DSH_REMOTE_STATE_ROOT unset
```

然后调用：

```text
test fixture/server helper
```

期望：

```text
fixture persistence remains disabled
OR
construction fails before touching real DSH_HOME
```

必须证明：

```text
inherited production env cannot silently activate persistence in tests
```

这就是 R5 原事故的直接 regression test。

---

# 10. Production Config Test

同时不能破坏产品默认：

直接测试：

```text
resolvePersistenceConfig({
  DSH_HOME: "D:\\example\\.dsh"
})
```

产品 config 仍应解析为：

```text
D:\example\.dsh\remote
```

即：

```text
production default remains correct
test harness prevents accidental production usage
```

不要通过删除 production default 来“修复”测试事故。

---

# 11. No Real `.credentials.yaml` Read

继续：

```text
do not open
do not hash contents
do not copy
```

R5A 如果需要证明未修改：

只记录：

```text
no code path / source scan
```

不要为了证明未读而再次读取它。

---

# 12. Acceptance Verification Script

建议新增：

```text
scripts/r5a-compliance-check.mjs
```

职责仅验证：

```text
real DSH_HOME remote absent
forbidden encoding artifacts absent
test roots are outside DSH_HOME
source tree encoding clean
```

不得：

```text
write real DSH_HOME
start production persistence
open listener
read credential
```

---

# 13. Compliance Script Output

推荐：

```text
R5A COMPLIANCE CHECK

real_state_root_exists: false
temp_root_guard: PASS
fixture_default_persistence: safe
bom: 0
ufffd: 0
invalid_utf8: 0
process_gate: PASS
```

machine-readable JSON 可同时生成到：

```text
D:\DSH-testing\docs\remote-mobile\_evidence\r5a-compliance.json
```

但不得写 DSH_HOME。

---

# 14. Encoding Gate

扫描整个：

```text
D:\DSH-testing\dsh-remote-gateway
```

至少：

```text
*.mjs
*.js
*.json
*.md
package-lock.json
test fixtures
```

必须：

```text
BOM = 0
U+FFFD = 0
invalid UTF-8 = 0
```

strict decoder：

```js
new TextDecoder('utf-8', { fatal: true })
```

---

# 15. Process-Command Evidence

R5A report 必须明确回答：

```text
Was Set-Content used?
Was Out-File used?
Was Add-Content used?
```

答案必须：

```text
NO
NO
NO
```

如果任何一个是 YES：

```text
R5A FAIL
```

不要把“使用后修复”算通过。

---

# 16. R5 Technical Reverification

重新执行：

```text
npm run test:r5
```

必须：

```text
155 / 155
```

如果 R5A 新增 tests：

R5 count 可增加。

但：

```text
原 155 个必须全部通过
```

---

# 17. Full Regression

运行：

```text
npm test
```

至少连续：

```text
3 clean runs
```

因为 R5 已经做过 10 runs，本阶段目标不是做性能压力，而是验证 remediation 后稳定。

每次：

```text
all tests pass
```

且每次前后：

```text
real DSH_HOME\remote absent
```

---

# 18. External Regression

重新运行：

```text
planner declared
planner full
codex declared
codex full
```

要求：

```text
327 / 0
676 / 9 same cases
175 / 0
220 / 219 / 1 same case
```

R5A 不修外部红测试。

---

# 19. Protected Hashes

仍：

```text
13 / 13 SHA-256
```

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

# 20. Persistence Correctness Smoke

R5A 使用 **temp state root** 再做一次最小 durable smoke：

```text
Gateway A
→ events 1..5
→ shutdown

Gateway B same temp root
→ recover highWater=5
→ next event 6
```

然后删除：

```text
only temp root
```

不得涉及真实 DSH_HOME。

---

# 21. Journal-vs-Ring Smoke

temp root：

```text
journal 1..20
ring 16..20
request last_sequence=10
```

必须：

```text
replay 11..20
```

证明 remediation 没有影响 R5 核心语义。

---

# 22. Real Root Watchdog

在 full suite 期间：

至少在：

```text
before run
after run
```

检查 real root。

更严格可在 test harness teardown 中检查：

```text
real root does not exist
```

但不要创建 filesystem watcher 写复杂逻辑。

简单、确定性的 assertion 更好。

---

# 23. No Feature Drift

R5A 不得改变：

```text
/api/v1 routes
WS protocol
close codes
journal format v1
retention defaults
snapshot schema
DSH cursor schema
auth policy
Host policy
Origin policy
```

任何这些变化：

```text
out of R5A scope
```

---

# 24. R5A Definition of Done

全部满足才通过。

## Process

- [ ] No `Set-Content` source edits。
- [ ] No `Out-File` source edits。
- [ ] No `Add-Content` source edits。
- [ ] No hidden cleanup used to mask violation。

## Real DSH_HOME

- [ ] `D:\DSH-work-test\.dsh\remote` absent before。
- [ ] absent after R5 tests。
- [ ] absent after full tests。
- [ ] absent after acceptance scripts。
- [ ] no real credential read。

## Harness

- [ ] temp-root guards verified。
- [ ] poisoned-env test passes。
- [ ] fixture persistence defaults safe。
- [ ] production default remains `%DSH_HOME%\remote`。

## Encoding

- [ ] BOM=0。
- [ ] U+FFFD=0。
- [ ] invalid UTF-8=0。

## Technical

- [ ] original R5 155 tests pass。
- [ ] all R1-R4 tests pass。
- [ ] full suite 3 consecutive runs。
- [ ] durable restart smoke pass。
- [ ] journal-over-ring replay smoke pass。

## External

- [ ] external baselines unchanged。
- [ ] protected hashes 13/13。

## Scope

- [ ] no R6 auth。
- [ ] no R7 supervisor。
- [ ] no UI。
- [ ] no SSH/Tailscale。
- [ ] R6 not started。

---

# 25. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R5A-REPORT.md
```

必须包含：

```text
1. Executive summary
2. Why R5A was required
3. R5 process violations carried forward
4. Remediation implemented
5. Files created
6. Files modified
7. Real DSH_HOME precondition
8. Test-root guard audit
9. Poisoned-environment test
10. Production-default preservation
11. Compliance script
12. Encoding verification
13. Process-command declaration
14. R5 technical test results
15. Full-suite repeated results
16. Durable restart smoke
17. Journal-vs-ring smoke
18. Real DSH_HOME postcondition
19. External regression
20. Protected hashes
21. Security review
22. Remaining known limitations
23. R6 readiness
24. Exact acceptance statement
```

---

# 26. 报告必须逐项回答

1. R5A 开始前 real `$DSH_HOME\remote` 是否存在？
2. R5A 完成后是否存在？
3. 自动测试是否曾在 R5A 中创建 real root？
4. 是否使用 `Set-Content` 修改项目文件？
5. 是否使用 `Out-File` 修改项目文件？
6. 是否使用 `Add-Content` 修改项目文件？
7. 是否发生 BOM？
8. 是否发生 U+FFFD？
9. 是否有 invalid UTF-8？
10. `makeTempStateRoot` 是否拒绝 DSH_HOME 内路径？
11. `assertTempStateRoot` 是否拒绝 DSH_HOME 内路径？
12. fixture helpers 是否默认安全？
13. poisoned-env test 的结果？
14. production default `%DSH_HOME%\remote` 是否仍正确？
15. 是否读取 `.credentials.yaml`？
16. original R5 155 tests 是否全部通过？
17. R1-R4 是否全部通过？
18. full suite 连续运行几次？
19. 是否每次都是 green？
20. durable restart smoke 是否继续 5→6？
21. journal 比 ring 更老的 range 是否继续可 replay？
22. external regression 是否新增失败？
23. protected hashes 是否 13/13？
24. 是否改变 journal format？
25. 是否改变 WS protocol？
26. 是否创建 R6 artefact？
27. R5A 是否完全遵守 process gate？

---

# 27. Acceptance Statement

若全部通过，报告最后必须写：

```text
R5A COMPLETE — COMPLIANCE REMEDIATION PASSED.
```

然后明确区分：

```text
R5 historical phase:
implementation passed
process gate violated

R5A:
clean remediation/acceptance gate passed

Combined acceptance:
R5 implementation is accepted for progression to R6,
with the original R5 violations retained in the audit record.
```

**不得改写历史说：**

```text
R5 was fully compliant
```

它不是。

---

# 28. Failure Statement

如果任一 process rule 再违反：

```text
R5A FAILED — PROCESS GATE VIOLATED.
```

如果 real root 再被写：

```text
R5A FAILED — REAL DSH_HOME TOUCHED.
```

不要：

```text
cleanup and continue
```

先停止并保留证据。

---

# 29. Stop Gate

R5A 完成后：

```text
STOP
```

不得进入 R6。

不得创建：

```text
src/remote/auth.mjs
auth/*
login/*
token/*
public/debug/remote/*
scripts/dsh-start.ps1
```

不得：

```text
enable sshd
install Tailscale
open firewall
capture DSH credential
```

等待人工验收。

---

# 30. 给 DSH 的执行指令

现在执行：

```text
Phase R5A — Compliance Remediation & Acceptance Gate
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R5-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r5-persistence-design.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R4-REPORT.md
```

执行顺序：

1. 确认 real `D:\DSH-work-test\.dsh\remote` 不存在。
2. 不读取 `.credentials.yaml`。
3. 审计 test-root guard。
4. 补充 poisoned-environment regression test。
5. 如必要，仅做最小 test-harness hardening。
6. 全程禁止 PowerShell text cmdlet 编辑项目文件。
7. 运行 compliance check。
8. 运行 original R5 tests。
9. 运行 full suite 连续 3 次。
10. 每轮确认 real DSH_HOME remote 不存在。
11. 运行 durable temp-root smoke。
12. 运行 journal-vs-ring smoke。
13. 重跑 external regressions。
14. 验证 protected hashes。
15. UTF-8/BOM/U+FFFD scan。
16. 再次确认 real DSH_HOME remote 不存在。
17. 生成 `PHASE-R5A-REPORT.md`。
18. STOP。
19. 不进入 R6。

如果 real root 在开始时已存在：

```text
STOP
R5A_REAL_STATE_ROOT_PREEXISTS
```

如果本阶段任何时候 test 创建 real root：

```text
STOP
R5A_REAL_STATE_ROOT_TOUCHED
```

如果使用被禁止的 PowerShell text cmdlet 修改项目文件：

```text
STOP
R5A_PROCESS_VIOLATION
```
