# Phase R5 — Durable Event Journal, Recovery & Cross-Restart Replay

> 前置阶段：Phase R4 — Realtime WebSocket Event Stream
>
> 当前项目：
>
> `D:\DSH-testing\dsh-remote-gateway`
>
> 本阶段目标：把 R4 的 **process-local Gateway Event ring + last_sequence replay** 升级为 **跨 Gateway 重启可恢复的 durable journal**，完成启动恢复、Gateway sequence 恢复、journal-backed replay、retention、完整性检测、crash-tail recovery，以及 Gateway 停机期间 DSH durable events 的 reconciliation seam。
>
> **R5 是第一个允许实现运行态磁盘持久化的阶段。**
>
> **R5 不实现 Phone Auth（R6）、DSH Supervisor / credential bootstrap（R7）、Mobile UI（R8）、SSH/Tailscale（R9）。**
>
> 完成后生成 `PHASE-R5-REPORT.md` 并停止，不得自动进入 R6。

---

# 0. R4 验收基线

R4 已验收通过：

```text
R1 tests:        82 / 82
R2 tests:       113 / 113
R3 tests:       161 / 161
R4 tests:       132 / 132
Full suite:     488 / 488
Runtime deps:   ws@8.21.3 only
```

外部 baseline：

```text
planner declared:   327 / 0 fail
planner full:       676 / 9 fail
codex declared:     175 / 0 fail
codex full:         220 total / 219 pass / 1 fail
protected hashes:   13 / 13
UTF-8:              BOM 0 / U+FFFD 0 / invalid UTF-8 0
```

R4 已提供：

```text
GatewaySequenceAllocator.seed()
EventsService per-session ring
EventsService.onEvent()
EventsService.sequenceBounds()
EventsService.eventsAfter()
WS last_sequence contract
resync_required
atomic replay → live handoff
bounded client backlog
```

R5 必须保持 WebSocket wire contract 兼容。

---

# 1. R5 最重要的语义边界

R5 必须明确区分三个问题。

## 1.1 Gateway 已经产生过的 Event

例如：

```text
Gateway sequence 100..160
```

这些 event 在 R5 后应写入 durable journal。

Gateway 重启后：

```text
seed sequence to 160
replay 101..160 if client needs them
```

这是 R5 的核心目标。

---

## 1.2 Gateway 停机期间 DSH 自己继续运行

例如：

```text
Gateway dies at sequence 160
DSH continues and commits a new assistant message
Gateway restarts later
```

这个 DSH event **不可能已经存在于 Gateway journal 中**。

因此：

```text
durable Gateway journal
!=
magically captures events while Gateway was not running
```

R5 必须为这类 gap 建立：

```text
DSH durable reconciliation
```

至少在 fixture 中实现并验证。

真实 authenticated reconciliation 仍可等 R7 验证。

---

## 1.3 非 durable DSH realtime data

以下内容可能无法在 Gateway 停机后重建：

```text
assistant token deltas
live-only waiting_input signal
process-local DSH control jobs
```

R5 不得声称能恢复这些数据。

可以恢复：

```text
committed durable messages/events
Gateway journal 已经写入的 realtime events
```

不能恢复：

```text
Gateway 停机期间从未观察到的 ephemeral event
```

---

# 2. Persistence Authority

R5 之后权威关系：

```text
Durable Event Journal   = replay authority
Per-session Ring        = hot cache only
Session Snapshot        = recovery accelerator
DSH durable history     = downtime reconciliation source
```

不得：

```text
Ring eviction
→ automatically conclude gap_not_available
```

如果 durable journal 仍有该 range：

```text
Replay must read journal.
```

---

# 3. Storage Root

Production default：

```text
%DSH_HOME%\remote
```

当前机器对应：

```text
D:\DSH-work-test\.dsh\remote
```

允许配置：

```text
DSH_REMOTE_STATE_ROOT
```

规则：

- production default 必须位于当前 `DSH_HOME` 下。
- override 必须是 absolute path。
- tests 必须使用 OS temp directory。
- R5 automated tests **不得写真实** `D:\DSH-work-test\.dsh\remote`。
- 不得把 root 设成 `DSH_HOME` 本身。
- 不得允许 `..` 逃逸 root。
- 所有 child path 都必须 canonicalize + containment check。

真实 `$DSH_HOME\remote` 的创建可以等 R7 production integration。

R5 的产品实现必须已经支持该默认路径，但测试以 temp root 验收。

---

# 4. Recommended On-Disk Layout

```text
remote/
  format.json

  state/
    session-views.a.json
    session-views.b.json
    gateway.lock

  events/
    session-<id>/
      00000000000000000001.jsonl
      00000000000000001001.jsonl
      ...

  quarantine/
    stale-locks/
    recovery/
```

不要把用户可控文件名直接变成任意路径。

session directory 只能来自已经验证的 Session ID。

---

# 5. Format Version

集中定义：

```text
PERSISTENCE_FORMAT_VERSION = 1
```

`format.json`：

```json
{
  "format": "dsh-remote-state",
  "version": 1
}
```

未知版本：

```text
STATE_VERSION_UNSUPPORTED
```

必须 fail closed。

R5 不实现 migration framework。

---

# 6. Journal Record

推荐每行一个 record：

```json
{
  "v": 1,
  "sequence": 143,
  "event": {
    "sequence": 143,
    "event": "assistant.delta",
    "session_id": "session-...",
    "timestamp": null,
    "observed_at": "...",
    "data": {},
    "source_sequence": null
  },
  "checksum": "sha256:..."
}
```

必须满足：

```text
record.sequence == event.sequence
event.session_id == directory session id
sequence integer
sequence > 0
```

Checksum 应覆盖固定 canonical payload：

```js
JSON.stringify([v, sequence, event])
```

然后：

```text
SHA-256
```

不要依赖 object property enumeration 的偶然顺序来重算 checksum。

---

# 7. JSONL Framing

规则：

```text
UTF-8
LF (`\n`)
one record per line
no BOM
```

`JSON.stringify()` 会 escape content 中的 newline，因此每 physical line 对应一个 record。

禁止：

```text
pretty printed multi-line records
```

---

# 8. Segmented Journal

不要让一个 session 形成无限大的单文件。

每 session 使用 segmented JSONL：

```text
events/<session-id>/<start-sequence>.jsonl
```

例如：

```text
00000000000000000001.jsonl
00000000000000001001.jsonl
```

filename：

```text
zero-padded decimal start sequence
```

不需要在 filename 写 end sequence。

reader 从文件内容确定 end。

---

# 9. Segment Rotation

配置建议：

```text
DSH_REMOTE_JOURNAL_SEGMENT_BYTES=4194304
```

默认：

```text
4 MiB
```

规则：

- segment 为空时允许一个 record 超过 segment target。
- 新 record 若会让非空 segment 越过 target，则先 rotate。
- closed segment 不再 append。
- latest segment 可 append。
- rotation 不改变 Gateway sequence。

segment target：

```text
是 Gateway 默认
不是 DSH 官方限制
```

---

# 10. Write-Ahead Ordering

这是 R5 的核心 correctness invariant：

```text
Gateway Event allocated
        ↓
Journal append completes
        ↓
Ring update
        ↓
EventsService.onEvent fan-out
        ↓
WebSocket client
```

**禁止：**

```text
publish first
journal later
```

否则：

```text
phone receives sequence 143
Gateway crashes
143 never reached disk
restart highWater=142
```

会造成 client watermark ahead。

---

# 11. Existing Synchronous EventsService

R2/R3/R4 当前 event generation 很大程度是 synchronous。

R5 实现时先审计真实 call graph。

允许两种方案：

## Option A — synchronous append

```text
fs.writeSync/open file handle
```

在 publish 前完成。

优点：

- 最小 API 改动。
- 保持 R1-R4 synchronous assumptions。
- ordering 最简单。

缺点：

- disk I/O 在 event path。

## Option B — serialized async commit queue

要求：

- producer 必须 await commit。
- 禁止 fire-and-forget。
- 所有旧 caller 必须正确改成 await。
- R1-R4 tests 必须保持绿。

不要为了“异步性能”破坏 write-ahead correctness。

R5 report 必须说明采用哪一种及原因。

---

# 12. Flush / Power-Loss Semantics

R5 必须区分：

```text
process restart durability
```

与：

```text
sudden machine power-loss durability
```

最低要求：

- append 在 publish 前已提交给 OS。
- graceful shutdown 必须 flush / `fdatasync`。
- segment rotate 前 flush closed segment。
- state snapshot 写完必须 flush。
- optional periodic `fdatasync` 可实现。

不要求每个 `assistant.delta` 都 `fsync`。

如果不是 per-event fsync：

报告必须明确：

```text
process restart: supported
sudden power loss: bounded recent loss may still occur
```

若 power loss 造成 client watermark ahead：

现有：

```text
sequence_ahead_of_server
→ resync_required
```

仍是安全 fallback。

---

# 13. Append Failure

例如：

```text
ENOSPC
EACCES
disk I/O error
checksum generation failure
```

则：

```text
event MUST NOT be published
```

必须进入：

```text
PERSISTENCE_WRITE_FAILED
```

状态。

不得：

```text
log warning and continue realtime delivery
```

因为这会破坏 durable sequence guarantee。

---

# 14. Persistence Health

扩展 `/api/v1/health`：

```json
{
  "data": {
    "gateway": "ready",
    "persistence": {
      "status": "ready",
      "format_version": 1
    }
  }
}
```

允许：

```text
ready
degraded
failed
```

不得把实际：

```text
DSH_HOME
state root full path
journal filenames
```

暴露给手机。

---

# 15. Runtime Persistence Failure Policy

journal runtime failure 后：

- 不再 fan-out 未持久化 Gateway events。
- health → `persistence.failed`。
- 新 mutating command 至少应 fail closed 或明确 degraded。

建议：

```text
POST messages → 503 PERSISTENCE_UNAVAILABLE
POST cancel   → 可根据当前 policy；若会产生 event，建议 503
```

Read-only REST 可以继续。

R5 report 必须说明具体策略并测试。

---

# 16. Per-Session Sequence Integrity

对于一个 session，journal append 必须：

```text
next.sequence == previousHighWater + 1
```

不只是：

```text
>
```

若出现：

```text
duplicate
backwards
gap
```

则：

```text
JOURNAL_SEQUENCE_ERROR
```

fail closed。

Retention 允许：

```text
earliest retained > 1
```

但 retained range 内必须连续。

---

# 17. Startup Order

**必须在任何 listener bind 前完成 recovery。**

顺序：

```text
resolve persistence config
↓
acquire writer lock
↓
validate format
↓
scan journals
↓
repair only allowed crash tail
↓
load session snapshot
↓
derive authoritative highWater
↓
seed GatewaySequenceAllocator
↓
restore SessionViewStore
↓
populate ring hot cache
↓
construct/start StatusService
↓
bind HTTP/WS 9445
```

禁止：

```text
listen first
recover later
```

否则 client 可能看到 sequence 从 1 开始后又跳到恢复值。

---

# 18. Writer Lock

R5 是 durable state 的单 writer。

创建：

```text
state/gateway.lock
```

获取方式：

```text
exclusive create
```

记录：

```json
{
  "pid": 12345,
  "instance_id": "uuid",
  "started_at": "..."
}
```

已有 lock：

- PID 明确仍 alive → `STATE_LOCKED`，拒绝启动。
- `EPERM` / 无法确认 → 视为 alive，拒绝启动。
- PID 明确不存在 → stale lock。

stale lock：

```text
move to quarantine/stale-locks/
```

再 acquire。

不得：

```text
kill owning PID
```

PID reuse 导致 false-positive refusal 是可接受的安全失败，比双 writer 好。

---

# 19. Lock Release

graceful shutdown：

仅当 lock 中：

```text
instance_id == current instance
```

才删除。

不得删除别的 Gateway instance 的 lock。

crash 留 stale lock：

下一次 startup 按 §18 恢复。

---

# 20. Crash Tail Recovery

允许自动修复的唯一 journal corruption：

```text
LAST segment
LAST physical line
unterminated
```

例如进程在 append 半行时崩溃。

处理：

1. 找到最后一个完整 `\n`。
2. truncate 到该位置。
3. 重新验证最后一个完整 record。
4. 记录 recovery evidence。
5. seed 到最后完整 sequence。

不得把半行拼成 JSON。

---

# 21. Corruption Fail-Closed

以下情况不得自动跳过：

```text
middle-of-file malformed JSON
checksum mismatch
unknown record version
duplicate sequence
sequence gap
backwards sequence
segment filename/start mismatch
complete final line but invalid checksum
session id mismatch
```

结果：

```text
JOURNAL_CORRUPT
```

默认：

```text
server does not bind
```

不要 silently skip bad event and continue。

---

# 22. Snapshot Store

R2 `SessionViewStore.snapshot()` 已存在。

R5 持久化 session metadata，但 snapshot **不是 replay authority**。

建议双槽：

```text
state/session-views.a.json
state/session-views.b.json
```

每个 snapshot：

```json
{
  "v": 1,
  "generation": 12,
  "written_at": "...",
  "sessions": [...],
  "checksum": "sha256:..."
}
```

写 inactive slot：

```text
truncate/write
flush
close
```

下次写另一槽。

startup：

```text
validate both
choose highest valid generation
```

这样一次 crash 不会同时破坏两个 slot。

---

# 23. Snapshot Authority

Journal 是 sequence/replay authority。

Snapshot 是：

```text
metadata recovery accelerator
```

若：

```text
snapshot.last_sequence < journal.highWater
```

合法：

```text
snapshot lagged
```

通过 journal tail 补齐。

若：

```text
snapshot.last_sequence > journal.highWater
```

这是 integrity violation：

```text
STATE_AHEAD_OF_JOURNAL
```

fail closed。

---

# 24. What Session State Is Safe to Restore

不要把 shutdown 前 status 当成当前真实 DSH status。

例如旧 snapshot：

```text
running
waiting_input
queued
```

Gateway 停机期间 DSH 可能已经变化。

startup 时：

保留：

```text
id
title
created_at
updated_at
workspace_id
cwd
last_sequence
persisted dsh_cursor
```

当前 runtime status：

推荐先进入：

```text
disconnected
```

直到 fresh DSH evidence 到达。

`last_known_status` 如保留，只能放 internal metadata，不能作为 current authoritative state。

---

# 25. waiting_input

R5 **仍不得宣称彻底解决 waiting_input**。

历史 journal 中可能保存：

```text
session.status waiting_input
```

但 Gateway 停机期间该问题可能已被回答。

因此 startup 后：

```text
不得仅靠旧 snapshot 直接恢复 current waiting_input
```

必须等待 fresh evidence。

在 durable reconciliation 完成前：

```text
disconnected / unknown-by-evidence
```

比 stale waiting_input 更安全。

---

# 26. Durable Replay Source

R5 新增抽象，例如：

```js
ReplayStore
```

接口：

```js
sequenceBounds(sessionId)
eventsAfter(sessionId, lastSequence, options?)
tail(sessionId, count)
```

实现：

```text
DurableReplayStore
```

读取策略：

```text
if requested range fully in ring
    → ring
else if range retained in journal
    → journal
else
    → resync_required
```

WS layer 不应该知道事件来自：

```text
RAM or disk
```

---

# 27. Async Replay

disk read 可能需要 async。

允许把 R4 replay source 改成 async interface：

```js
await sequenceBounds()
await eventsAfter()
```

但：

- WebSocket protocol 不变。
- replay ordering 不变。
- atomic replay→live handoff 不变。
- R4 132 tests 全绿。
- event arriving during disk replay 仍 exactly once。

新增 race test：

```text
slow journal read + live event
```

必须无丢失、无重复。

---

# 28. Ring Is Hot Cache

startup：

对每个 session：

```text
load last min(ringSize, retainedEvents)
```

填充 per-session ring。

ring eviction：

```text
不再决定 durable earliest_available
```

`hello.sequence.earliest_available`：

R5 后应来自：

```text
DurableReplayStore authoritative retained boundary
```

而不是 ring boundary。

---

# 29. Retention Policy

Journal 不能无限增长。

默认建议：

```text
DSH_REMOTE_JOURNAL_MAX_EVENTS_PER_SESSION=50000
DSH_REMOTE_JOURNAL_MAX_BYTES_PER_SESSION=67108864
```

即：

```text
50,000 events
64 MiB / session
```

这些是：

```text
Gateway defaults
```

不是 DSH limits。

配置必须：

```text
positive safe integers
bounded
documented
```

---

# 30. Retention by Whole Segments

优先删除：

```text
oldest CLOSED segments
```

不要 rewrite active segment。

保持：

```text
至少最新 segment
```

删除后：

```text
journal earliest_available
```

随之向前移动。

旧 client：

```text
last_sequence < durable earliest - 1
→ existing resync_required gap_not_available
```

协议不变。

---

# 31. Retention Must Not Reset HighWater

即使旧 segment 删除：

```text
highWater
```

仍是该 session 最大已使用 Gateway sequence。

不能因为：

```text
earliest retained now 4000
```

就让 allocator 从 4000 重启。

highWater 来源：

```text
latest retained journal record
```

由于至少保留 latest segment，必须可恢复。

---

# 32. DSH Durable Cursor Persistence

Session internal snapshot 必须持久化：

```text
last known DSH durable cursor
```

名称建议：

```text
dsh_cursor
```

它：

```text
不是 Gateway sequence
不出现在 mobile session projection
```

用于 Gateway downtime reconciliation。

---

# 33. Downtime Reconciliation

创建组件，例如：

```text
src/remote/persistence/reconcile.mjs
```

目标：

```text
persisted dsh_cursor = 500
fresh DSH follow snapshot cursor = 530
```

则：

```text
fetch durable DSH records 501..530
normalize them
emit NEW Gateway Events with NEW sequences
journal them
advance persisted dsh_cursor
```

不要复用旧 Gateway sequence。

这些是：

```text
Gateway restart 后首次观察到的 durable DSH facts
```

因此获得新的 Gateway sequence 是正确的。

---

# 34. Reconciliation Source

只允许：

```text
DshAdapter
session.page / adapter raw history
fresh follow snapshot
```

不得：

```text
direct read session.v3.jsonl.zstd
```

如果现有 `getMessages().raw` 足够：

复用它。

如果不足：

允许 additive Adapter capability，例如：

```js
getRawEvents(sessionId, range)
```

但：

- 仍封装在 Adapter。
- R1 六方法不变。
- wire 不泄漏到 persistence layer。
- contract tests 必须新增。

---

# 35. Reconciliation Ordering

启动/重连 reconciliation 必须：

```text
observe fresh DSH cursor C
↓
fetch durable records > persisted cursor
↓
process in DSH source_sequence order
↓
generate new Gateway events
↓
journal-before-publish
↓
persist new dsh_cursor C
```

如果 reconcile 中途失败：

```text
不要 advance dsh_cursor beyond last successfully committed source record
```

否则会永久跳过 DSH event。

---

# 36. Reconciliation Idempotency

Gateway 在 reconcile 后再次 crash：

同一个 DSH durable event 不得生成第二次 Gateway event。

需要持久化：

```text
highest reconciled DSH cursor
```

或等价 deterministic checkpoint。

测试：

```text
reconcile 501..530
crash after 520
restart
reconcile again
→ 501..520 not duplicated
→ 521..530 emitted once
```

---

# 37. What Reconciliation Cannot Recover

必须明确：

无法恢复 Gateway down-time 中的：

```text
assistant-stream token deltas
ephemeral heartbeat
phone connection events
live-only waiting_input unless DSH exposes durable evidence
process-local control transitions
```

但最终 durable assistant/user/tool messages：

应尽可能通过 DSH history 恢复。

---

# 38. Journal + Reconciliation Relationship

Gateway journal 保存：

```text
Gateway observed events
```

DSH history 是：

```text
source-of-truth fallback for durable events Gateway never observed
```

不要把 DSH history 直接当 Gateway replay journal。

正确：

```text
DSH missed durable fact
→ normalize
→ allocate NEW Gateway sequence
→ append to journal
→ publish
```

---

# 39. Startup Recovery Sequence

完整建议：

```text
Acquire persistence lock
↓
Recover journals
↓
Load best valid snapshot
↓
Seed each GatewaySequenceAllocator from journal highWater
↓
Restore stable session metadata
↓
Set recovered sessions current status to disconnected
↓
Preload ring tail from journal
↓
Start Gateway services
↓
When DSH available:
    run durable reconciliation
    start control/follow
↓
Only then claim DSH ready
```

HTTP listener可以在 persistence recovery 后启动。

DSH auth/reconciliation live execution仍可因 R7未完成而是：

```text
degraded / fixture-tested
```

---

# 40. Server Startup Failure

如果：

```text
format unsupported
journal corrupt
lock active
state ahead of journal
cannot create state root
cannot write journal
```

则：

```text
server MUST NOT bind 9445
```

测试：

```text
port remains closed
```

---

# 41. Graceful Shutdown Order

R5 后：

```text
1. stop accepting WS upgrades / new HTTP mutations
2. notify + close WS clients
3. stop StatusService / DSH event producers
4. wait any in-flight event commit
5. flush/fdatasync journal handles
6. write final session snapshot
7. close journal handles
8. release persistence lock
9. adapter.close()
10. complete HTTP shutdown
```

具体实现可适应 R4 现有 lifecycle，但必须满足：

```text
no producer after persistence close
```

---

# 42. Snapshot Scheduling

不能只靠 graceful shutdown。

建议：

```text
debounced snapshot every 1–5 seconds when dirty
```

或：

```text
every N events + graceful shutdown
```

必须：

- bounded frequency。
- timer 可注入测试。
- shutdown flush dirty snapshot。
- crash 最多丢 snapshot metadata，不丢 journal sequence。

---

# 43. Journal Index

启动时可建立 in-memory index：

```text
session
segment start
segment end
byte size
event count
```

replay 时：

不要每次从第一个 segment 扫描。

可以：

```text
binary/select segment by start/end
```

但 R5 不要求复杂数据库。

禁止为 R5 引入 SQLite，除非 audit 证明 JSONL 方案无法满足。

默认继续：

```text
zero new persistence dependency
```

---

# 44. Writer Lock Tests

覆盖：

```text
first writer acquires
second writer refused
stale dead PID lock recovered
EPERM/unknown owner → refused
lock release
wrong instance cannot release
crash-style stale lock
```

不要实际 kill unrelated Node process。

child process test 若需要，只能操作 test-owned PID。

---

# 45. Journal Tests

至少：

```text
append
strict sequence
segment rotate
checksum
restart read
multi-session isolation
UTF-8
opaque content
large record
append failure
```

---

# 46. Crash Recovery Tests

覆盖：

```text
unterminated final line → truncate allowed
middle malformed line → fail
last complete checksum mismatch → fail
unknown version → fail
gap → fail
duplicate → fail
backwards → fail
wrong session → fail
wrong segment start → fail
```

---

# 47. Snapshot Tests

覆盖：

```text
A/B generation
one slot corrupt → use other
both corrupt → reconstruct minimal from journal
snapshot behind journal → replay tail
snapshot ahead → fail
volatile status not trusted
stable metadata restored
```

---

# 48. Cross-Restart Replay Tests

模拟真实 restart：

```text
Process A
  emit Gateway events 1..100
  journal
  client processed through 70
  stop

Process B
  recover journal
  seed highWater 100
  ring preload tail
  WS connect last_sequence=70
```

期望：

```text
replay 71..100 exactly once
replay_complete
next live event = 101
```

不能：

```text
sequence restart at 1
4001 only because ring was lost
```

---

# 49. Journal-vs-Ring Test

设：

```text
journal holds 1..5000
ring holds 4001..5000
client last_sequence = 3500
```

R5 应：

```text
read 3501..5000 from journal
```

而不是：

```text
gap_not_available
```

这是 R5 最关键验收之一。

---

# 50. Retention Tests

例如：

```text
segments retain 1001..5000
client last_sequence = 1000
→ replay works

client last_sequence = 999
→ resync gap_not_available
```

验证：

- delete only closed segments。
- active segment kept。
- highWater remains 5000。
- ring cache unaffected except preload policy。
- retained range contiguous。

---

# 51. Downtime Reconciliation Tests

fixture DSH：

```text
persisted dsh_cursor = 50
Gateway down
DSH durable source advances to 55
restart
```

reconcile：

```text
source 51..55
→ new Gateway events 101..105
→ journaled
→ client gets them
→ persisted dsh_cursor=55
```

再 restart：

```text
no duplicate 51..55
```

---

# 52. Reconciliation Partial Failure Test

模拟：

```text
source 51 OK
52 OK
53 persistence fails
```

结果：

```text
51/52 committed
checkpoint advances only to 52
53+ not marked reconciled
restart retries 53+
```

不得跳到 55。

---

# 53. waiting_input Recovery Test

旧 snapshot：

```text
status=waiting_input
```

restart：

```text
current status MUST NOT blindly become waiting_input
```

如果无 fresh DSH evidence：

```text
disconnected
```

或现有 state machine 的等价 recovery-safe状态。

测试明确锁死这个行为。

---

# 54. Persistence Security

Journal 会包含用户会话数据，这是功能要求。

但不得包含 Gateway/DSH credentials。

journal append 前：

- structural secret-field guard 保留。
- 不允许 `cookie` / `authorization` / internal credential object。
- 不把 launch token 写入 state。
- 不把 full env 写入 state。
- 不把 `.credentials.yaml` 内容复制进 root。

注意：

**不要擅自改写用户消息正文。**

用户文本里出现字符串 `"token"` 并不等于应被删除。

只阻止内部 credential material 泄漏。

---

# 55. File Permissions

创建目录时建议：

```text
0700
```

文件：

```text
0600
```

在 Windows 上 mode 不是完整 ACL security boundary。

因此 R5 report 必须明确：

```text
inherits Windows user/profile ACL
R7 may add explicit ACL hardening
```

R5 不调用：

```text
icacls
```

去修改系统 ACL。

---

# 56. Path Safety

任何 path：

```text
path.resolve(root, child)
```

后必须确认：

```text
resolved path is under root
```

journal session directory：

只能由已验证 session id 构造。

拒绝：

```text
..
/
\
NUL
drive colon
alternate separator tricks
```

---

# 57. Persistence Errors

集中 vocabulary，例如：

```text
PERSISTENCE_UNAVAILABLE
PERSISTENCE_WRITE_FAILED
STATE_LOCKED
STATE_VERSION_UNSUPPORTED
JOURNAL_CORRUPT
JOURNAL_SEQUENCE_ERROR
STATE_AHEAD_OF_JOURNAL
STATE_PATH_INVALID
STATE_SNAPSHOT_INVALID
```

映射到 HTTP 时：

```text
503
```

为主。

不得向手机泄漏真实磁盘 path。

---

# 58. Replay API Compatibility

以下 R4 wire frame 不变：

```text
hello
event
replay_complete
resync_required
overflow
heartbeat
```

close codes 不变：

```text
4001 RESYNC_REQUIRED
4003 BACKLOG_OVERFLOW
...
```

R5 只改变：

```text
server能保存多长、跨不跨restart
```

不能要求 R4 client protocol version bump。

---

# 59. `earliest_available`

R4：

```text
ring earliest
```

R5：

```text
durable journal earliest retained sequence
```

必须更新：

```text
hello.sequence.earliest_available
```

语义文档。

`latest`：

```text
durable journal highWater
```

在 persistence ready 时不得比 journal 落后。

---

# 60. No Client ACK Persistence

R4 没有 application ACK。

R5 也不要自行保存：

```text
per-phone watermark
```

服务器不知道 phone 是否真正处理。

客户端继续自己带：

```text
last_sequence
```

retention 是固定 policy，不基于 client ACK。

---

# 61. Real `$DSH_HOME` Policy in R5

R5 自动测试：

```text
MUST use temp root
```

R5 manual validation：

优先也使用：

```text
temp fixture root
```

除非专门做生产路径 smoke test。

若做 production path smoke：

- 只能创建 `D:\DSH-work-test\.dsh\remote`。
- 不得修改任何现有 `.dsh` 文件。
- smoke artifacts 必须可明确识别并在测试后清理。
- 报告必须列出创建/删除路径。

推荐：

```text
不要在 R5 就污染 real DSH_HOME
```

等 R7 supervisor 首次生产启动时正式创建。

---

# 62. No `.credentials.yaml`

继续严格禁止：

```text
read
copy
hash content for logic
persist
```

如仅为“未修改证据”读取 metadata/hash：

也尽量避免。

R5 不需要 credentials。

---

# 63. Source Editing Process Gate

R2、R4 均发生过 PowerShell text-cmdlet 编码事故。

R5 将此升级为正式 process gate。

**禁止：**

```powershell
Set-Content
Out-File
Add-Content
```

修改：

```text
*.mjs
*.js
*.json
*.md
```

project files。

如果再次发生：

即使最终文件修复：

```text
R5_PROCESS_VIOLATION
```

必须出现在报告摘要中。

并且：

```text
phase cannot be described as "fully compliant"
```

必须明确：

```text
implementation tests passed but process gate violated
```

优先使用：

```text
file-edit tools
Node fs with explicit utf8
```

---

# 64. Encoding Gate

完成：

```text
BOM = 0
U+FFFD = 0
invalid UTF-8 = 0
```

对：

```text
source
tests
docs
state format fixtures
```

全部扫描。

真实 journal test files也必须 strict UTF-8。

---

# 65. No New Network Surface

R5：

- 不新增 listener。
- 不新增 port。
- REST/WS 继续 9445 loopback。
- 不改 Host/Origin policy。
- 不实现 auth。
- 不实现 TLS。

R6 才做 security productionization。

---

# 66. Runtime Dependency Policy

R5 优先 Node built-ins：

```text
node:fs
node:path
node:crypto
```

不要新增数据库/locking framework，除非实际 implementation audit 证明必要。

若新增 dependency：

报告必须解释。

`ws@8.21.3` 必须继续 pinned。

---

# 67. R5 Tests

建议至少新增：

```text
persistence-config.test.mjs
persistence-lock.test.mjs
journal-record.test.mjs
journal-segments.test.mjs
journal-corruption.test.mjs
state-snapshot.test.mjs
startup-recovery.test.mjs
durable-replay.test.mjs
retention.test.mjs
downtime-reconcile.test.mjs
persistence-health.test.mjs
persistence-shutdown.test.mjs
persistence-security.test.mjs
r5-integration.test.mjs
```

---

# 68. R5 Full Integration Scenario

模拟：

```text
Gateway A starts with empty temp state
↓
events 1..80
↓
client consumes through 60
↓
Gateway A graceful stop

DSH fixture produces durable source events while Gateway is "down"
↓
Gateway B starts same state root
↓
journal recovery highWater=80
↓
allocator seeded to 80
↓
ring tail preloaded
↓
DSH reconcile emits new Gateway 81..85
↓
WS connect last_sequence=60
↓
replay 61..85
↓
replay_complete
↓
new live event = 86
```

验证：

```text
no duplicate
no gap
strict order
journal before publish
```

---

# 69. Crash Integration Scenario

```text
Gateway A journal:
1..99 complete
record 100 half-written
process "crashes"
```

Gateway B：

```text
truncate incomplete 100
seed 99
new event = 100
```

前提：

```text
100 was never fully committed/published
```

测试必须证明。

---

# 70. Mid-File Corruption Scenario

```text
1..50 valid
51 checksum invalid
52..100 valid bytes
```

startup：

```text
JOURNAL_CORRUPT
server port remains unbound
```

不得：

```text
skip 51
serve 52..100
```

---

# 71. Disk Failure Scenario

运行中：

```text
append event 120
→ ENOSPC
```

必须：

```text
120 not added to ring
120 not fan-out
allocator/persistence state does not pretend committed
health persistence failed
```

是否 allocator sequence 120 可以被“burned”但不 reused：

推荐：

```text
yes
```

不要 reuse 已分配但 commit failed 的 sequence，避免 ambiguous identity。

如果采用 burned sequence：

journal 下一次成功 event 可能是：

```text
121
```

这会形成 durable gap。

因此更好：

```text
fail persistence permanently / stop accepting new event generation
```

直到 restart/recovery，而不是继续到 121。

R5 必须选一种安全策略并记录。

推荐：

```text
fatal persistence state
no further event allocation/publish until restart
```

---

# 72. Health / Readiness Semantics

如果 persistence recovery 失败：

```text
server never binds
```

如果 runtime persistence 失败：

```text
HTTP process still exists
health 200
gateway/persistence marks failed
mutating operations 503
```

不得返回：

```text
gateway ready=true
```

而隐藏 persistence failure。

---

# 73. R5 Regression Requirements

R5 完成后：

```text
R1  82 / 82
R2 113 / 113
R3 161 / 161
R4 132 / 132
R5 new tests all green
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

正确 CWD：

```text
D:\DSH-testing\dsh-gpt-planner-bridge
```

---

# 74. R5 Definition of Done

## Persistence

- [ ] format v1。
- [ ] canonical state root。
- [ ] writer lock。
- [ ] segmented per-session journal。
- [ ] record checksum。
- [ ] write-ahead before publish。
- [ ] flush on shutdown/rotation。
- [ ] crash-tail repair。
- [ ] mid-file corruption fail closed。
- [ ] A/B session snapshot。
- [ ] startup recovery before bind。

## Sequence

- [ ] allocator seeded from journal。
- [ ] next sequence continues。
- [ ] no restart reset。
- [ ] no duplicate/backwards/gap inside journal。
- [ ] ring preloaded from journal tail。

## Replay

- [ ] journal authoritative。
- [ ] ring hot cache。
- [ ] replay older than ring but inside journal works。
- [ ] retention boundary drives earliest_available。
- [ ] R4 protocol unchanged。
- [ ] replay/live atomicity still holds with disk reads。

## Reconciliation

- [ ] persisted DSH cursor。
- [ ] durable DSH downtime gap detected。
- [ ] fixture reconciliation implemented。
- [ ] missed durable records get NEW Gateway sequences。
- [ ] reconciliation idempotent。
- [ ] partial reconciliation resumes safely。
- [ ] ephemeral gaps honestly documented。

## Retention

- [ ] bounded events/bytes。
- [ ] whole-segment deletion。
- [ ] highWater preserved。
- [ ] old client receives existing `4001` resync。

## Failure

- [ ] lock conflict fail closed。
- [ ] unsupported format fail closed。
- [ ] corruption fail closed。
- [ ] runtime disk failure stops non-durable fan-out。
- [ ] health reflects persistence failure。

## Security

- [ ] no credentials journaled。
- [ ] no `.credentials.yaml` read。
- [ ] path containment。
- [ ] validated session paths。
- [ ] best-effort private file modes。
- [ ] mobile health does not leak paths。

## Scope

- [ ] no Phone Auth。
- [ ] no supervisor。
- [ ] no mobile UI。
- [ ] no SSH/Tailscale。
- [ ] no new network listener。
- [ ] R6 not started。

## Process

- [ ] no PowerShell text cmdlet source edits。
- [ ] BOM=0。
- [ ] U+FFFD=0。
- [ ] invalid UTF-8=0。

## Regression

- [ ] R1-R4 green。
- [ ] R5 green。
- [ ] external baselines unchanged。
- [ ] protected 13/13。

---

# 75. Required Report

创建：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R5-REPORT.md
```

必须包含：

```text
1. Executive summary
2. R4 baseline confirmation
3. Scope completed
4. Files created
5. Files modified
6. Persistence architecture
7. State-root policy
8. Format/version
9. Journal record format
10. Segmentation
11. Write-ahead ordering
12. Flush/durability semantics
13. Writer lock
14. Startup recovery
15. Crash-tail repair
16. Corruption policy
17. Session snapshot
18. Sequence recovery
19. Ring hot-cache policy
20. Durable replay source
21. Retention
22. DSH cursor persistence
23. Downtime reconciliation
24. Reconciliation limitations
25. Runtime disk failure
26. Health integration
27. Shutdown lifecycle
28. Security/path review
29. Test results
30. R1-R4 regression
31. External regression
32. Protected hashes
33. UTF-8/process gate
34. Known limitations
35. Deferred R6/R7/R8/R9
36. R6 readiness
37. Exact stop statement
```

---

# 76. 报告必须逐项回答

1. R5 state root 默认在哪里？
2. automated tests 是否写了真实 DSH_HOME？
3. journal 是否 per-session？
4. 是否 segmented？
5. record checksum 算法是什么？
6. event 是否在 journal commit 后才 fan-out？
7. 若 disk append 失败，event 是否仍会发给手机？
8. 是否每 event fsync？若否，power-loss guarantee 是什么？
9. Gateway restart 后 sequence 是否从旧 highWater+1 继续？
10. startup recovery 是否在 bind 9445 前完成？
11. ring 是否仍是 replay authority？
12. 请求 range 比 ring 老但仍在 journal 时会怎样？
13. `earliest_available` 现在来自哪里？
14. retention 默认 event/byte limits 是什么？
15. retention 是否删除 active segment？
16. retention 是否重置 highWater？
17. half-written final line 如何处理？
18. mid-file corruption 如何处理？
19. checksum mismatch 如何处理？
20. duplicate/gap/backwards sequence 如何处理？
21. snapshot 是 replay authority 吗？
22. snapshot ahead of journal 会怎样？
23. old `running/waiting_input` 是否会被盲目恢复为 current status？
24. 是否持久化 DSH cursor？
25. Gateway downtime 中 DSH durable events 如何补？
26. downtime reconcile 是否会复用旧 Gateway sequence？
27. reconcile crash 后是否会重复事件？
28. assistant deltas 能否跨 Gateway downtime 重建？
29. waiting_input 能否可靠跨 downtime 重建？
30. writer lock 如何防止双进程？
31. stale lock 如何处理？
32. 是否会 kill 另一个 PID？
33. runtime ENOSPC 后 Gateway 如何 fail closed？
34. health 是否显示 persistence state？
35. journal 是否可能写 cookie/token/credentials？
36. 是否读取 `.credentials.yaml`？
37. 是否新增 listener/port？
38. 是否新增 runtime dependency？
39. 是否用了 PowerShell `Set-Content/Out-File/Add-Content` 改项目文件？
40. BOM/U+FFFD/UTF-8 scan？
41. R1/R2/R3/R4 tests 是否全绿？
42. R5 新测试数量？
43. external regression 是否出现新 fail？
44. protected hashes 是否 13/13？
45. 是否进入 R6？

---

# 77. Stop Gate

完成 R5 后输出：

```text
R5 COMPLETE — STOPPING HERE.
```

不得创建/实现：

```text
src/remote/auth.mjs          # Phone Auth
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
open firewall
modify DSH profile
read .credentials.yaml
capture DSH launch token
```

等待人工验收。

---

# 78. 给 DSH 的执行指令

现在执行：

```text
Phase R5 — Durable Event Journal, Recovery & Cross-Restart Replay
```

首先阅读：

```text
D:\DSH-testing\dsh-remote-gateway\PHASE-R4-REPORT.md
D:\DSH-testing\dsh-remote-gateway\docs\r4-websocket-contract.md
D:\DSH-testing\dsh-remote-gateway\docs\r4-reconnect-semantics.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R3-REPORT.md
D:\DSH-testing\dsh-remote-gateway\PHASE-R2-REPORT.md
```

执行顺序：

1. 确认 488/488 baseline。
2. 审计 EventsService emit call graph，决定 sync write 或 awaited commit queue。
3. 先写 `docs/r5-persistence-design.md`。
4. 定义 persistence format v1。
5. 实现 config/path containment。
6. 实现 single-writer lock。
7. 实现 journal record/checksum。
8. 实现 segmented journal。
9. 接入 journal-before-publish。
10. 实现 A/B snapshot。
11. 实现 startup recovery + allocator seed。
12. preload ring hot cache。
13. 把 replay source 升级为 ring + durable journal。
14. 保持 R4 wire protocol不变。
15. 实现 retention。
16. 实现 persisted DSH cursor。
17. 实现 fixture-backed downtime reconciliation。
18. 实现 persistence health/failure state。
19. 实现 graceful flush/shutdown。
20. 完成 R5 tests。
21. 重跑 R1/R2/R3/R4。
22. 重跑 external baseline。
23. 验证 protected hashes。
24. 扫描 BOM/U+FFFD/invalid UTF-8。
25. 生成 `PHASE-R5-REPORT.md`。
26. STOP。
27. 不进入 R6。

如果无法保证：

```text
journal append before fan-out
```

则：

```text
STOP IMPLEMENTATION
R5_DURABILITY_ORDERING_UNRESOLVED
```

如果 durable journal 与 ring 无法给出一致 replay boundary：

```text
STOP IMPLEMENTATION
R5_REPLAY_AUTHORITY_UNRESOLVED
```

如果 DSH durable history 无法可靠按 persisted cursor 做 reconciliation：

```text
R5_DOWNTIME_RECONCILIATION_LIMITED
```

允许继续完成 journal/replay，但必须把该限制明确写入报告，绝不能声称 Gateway downtime 内的 DSH activity 已完整恢复。
