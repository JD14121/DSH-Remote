# Harness Remote：电脑端配置向导

安装前准备 Windows、Windows PowerShell 5.1+、Node.js 24+（npm/npx）。先阅读仓库根目录 [README](../README.md)，尤其是生产域名固定与独立证书部署的限制。

## 新安装

1. 克隆仓库，执行 `npm ci`，运行 `scripts\Harness-Remote-Setup.cmd`。
2. 选择本次克隆目录、实际工作区、独立 DSH 数据目录与日志目录。目录不必使用 D 盘。
3. 端口默认桌面 3080、生产 DSH 3081、Gateway 9445。端口必须互不冲突；USB 开发代理及现有生产 relay 使用默认 Gateway 9445。
4. 初次未完成外网部署时不勾选 relay。勾选时需提供已经准备好的 bridge 配置、FRPC 配置和 FRPC 程序。向导不签发证书，不修改 DNS、VPS、防火墙或 FRP 配置。
5. 点击「检查配置」。缺少项目依赖时可点击「安装项目依赖」。安装按 lockfile 执行 npm ci；已有依赖不会重复安装。
6. 点击「保存并创建快捷方式」。桌面生成 Harness Remote 与 Harness Remote Setup 两个快捷方式。保存不启动服务。
7. 双击 Harness Remote，启动缺失组件或复用健康组件。遇到未知占用、不完整生产启动或非回环监听时，拒绝替换现有进程。

配置默认为 `%LOCALAPPDATA%\HarnessRemote\pc-config.json`。新安装合规门默认开启。旧部署的例外选项仅用于已经接受的迁移，不用于绕过新的安装错误。

## 已有环境迁移

向导尝试识别旧生产状态。迁移前核对 DSH 数据目录与工作区，确保指向自己的真实数据；识别不到时手动选择。更换数据路径不会移动或复制历史会话。保存前会检查当前 supervisor：运行中不能改变项目、数据、工作区、端口或 relay。

## 命令行与配置优先级

```powershell
.\scripts\harness-start.ps1 -DiagnoseOnly -NoPause
.\scripts\harness-start.ps1 -NoPause
.\scripts\dsh-status.ps1 -Json
```

管理脚本支持 `-ConfigPath '绝对路径'`：脚本显式路径 → `HARNESS_REMOTE_CONFIG` → 默认用户配置。明确指定但不存在的文件会报错。Node 生产启动器也读取同一份配置。

需要改变关键设置时，用旧配置执行 `dsh-stop.ps1`，再保存并启动新设置。不要在 supervisor 仍运行时手工绕过向导改配置。令牌与证书私钥不写入配置 JSON；它只保存路径与选项。

## 保存保护与恢复

变更前保存备份，写入期间设置同目录 `.lock`，读取者拒读写入中的配置。普通目录使用 rename；Windows EFS 目录出现同目录 rename 失败时，采用锁保护、备份、复制与失败回滚，不改变目录加密属性。

异常退出若留下 `.lock`，先关闭向导，确认锁记录的写入 PID 已结束，保留当前文件与备份。确认当前 JSON 完整，或在服务停止后恢复已核验的备份，再移除该配置对应的锁并重新诊断。不得在保存过程中删除锁，也不应通过解除加密或扩大 ACL 来处理该问题。

该向导完成电脑侧配置；新用户的 Android 生产身份、域名改造、手机配对和无人值守运行需要分别完成，详见 README。
