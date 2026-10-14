# Mineflayer Cannon Builder

基于 Mineflayer 的 Minecraft Java 版建造工具，支持最多 30 个 bot 在同一进程中协作，按全局 Y 层从下向上施工。bot 实际飞到目标附近，通过玩家放置、挖掘和容器交互完成任务。默认端点为 **Minecraft 1.21.11，127.0.0.1:25566**。

本仓库导出建造、恢复、审计工具和测试，**不包含主炮、下界加载器或控制面板蓝图**。`schematics/` 中保留的是原项目示例，不能替代这些蓝图。当前传送门物品循环装置的故障尚未解决；结构、容器和实体装配验收通过，不等于已经通过发射或整机运行验收。

## 环境与安装

- Node.js **22 或更高版本**；CI 覆盖 Node.js 22、24。
- Java **21**：本地 Minecraft 服务器与可选的 Java agent 使用。
- Minecraft Java **1.21.11** 已通过 30 bot、三层 180 方块实测，容器组件另经 GUI 与服务器回读验证。旧 **1.21.4** 施工路径保留；完整主炮的发射功能未验证。
- bot 使用离线账号和创造模式材料；需要飞行权限。调试棒校准还需要 OP 权限。

```bash
git clone https://github.com/Tlingxie/mineflayer-cannon-builder.git
cd mineflayer-cannon-builder
npm ci
npm test
```

`package.json` 保留 `mineflayer-builder` 名称及 `file:.` 自依赖，使原示例的导入方式继续工作；`private: true` 防止误发布到同名 npm 包。此仓库没有自动 npm 发布工作流。

## 网页施工控制台

运行 `npm run web`，打开 **http://127.0.0.1:3210**。填写原点，拖入
`.litematic` / `.schem` 蓝图，选择 1–30 个 bot 后即可开始施工。
也可拖入 `.mid` / `.midi`，自动转换为带起点按钮的音符盒红石音乐轨道，
下载生成的 `.schem` 或直接交给 bot 施工。支持多轨速度变化、音色映射和和弦，
节拍量化为 0.1 秒；页面会显示音域调整、播放方式和占地。
页面提供蓝图俯视预览、逐层进度、日志和停止按钮，刷新页面可以继续查看当前任务。
默认连接已有的 Minecraft 1.21.11 `127.0.0.1:25566`，自动核验本机 FIFO
控制台入口，bot 仍须飞近后逐块放置。网页不会自动冻结或重启 Minecraft。
完整操作和服务器要求见 [网页控制台说明](docs/web-console.md)。

## 接入已有 1.21.11 服务器

对于使用本机 FIFO 控制台和日志的服务，可以核对进程身份并生成独立配置，不重启或冻结服务器：

```bash
npm run server:attach
npm run multi-build:dev -- --server-profile .runtime/servers/1.21.11-25566.json --prepare-workers --prefix cannon --origin 256,64,256
```

请先选有地面的空地。`--prepare-workers` 仅为本次在线施工账号设置创造模式和 OP；主炮封闭矿车等装配仍需要事先安排冻结施工。服务器重启后重新运行 `server:attach`。完整说明及实测记录见 [1.21.11 使用说明](docs/minecraft-1.21.11.md)。

## 可选：启动旧版 1.21.4 受管施工服

首次启动会下载官方 Minecraft 1.21.4 服务端。先阅读 [Minecraft EULA](https://aka.ms/MinecraftEULA)，接受后显式传入参数：

```bash
npm run server:start -- --accept-eula
npm run server:status
```

已接受 EULA 的同一目录后续可直接 `npm run server:start`。服务只监听 `127.0.0.1`，首次从 `25565`、`25566` 中选择空闲端口；**实际端口以 `server:status` 为准**，下文示例中的端口需要相应替换。世界、日志和本机 RCON 配置写入被 Git 忽略的 `.runtime/`，不要提交该目录。

默认创建离线创造模式平坦世界，并给 `builder00` 至 `builder29` 配置 OP。服务器保持 tick 冻结：玩家仍能飞行、放置和打开容器，但流体扩散、活塞和实体运动需要后续自然初始化。冻结不会阻止所有同步邻居更新。

新建服务器的默认配置已经修正为 `allow-nether=true`。旧世界若仍为 `false`，需保存、停止服务器，修改该世界实际使用的 `server.properties` 后重启；仅重新点燃门不会重新加载这项配置。允许进入下界不代表传送门物品循环装置已修好。

## 30 bot 严格逐层施工

先运行内置的三层、180 个目标测试；请选空地，并使用上一步查到的端口：

```bash
npm run multi-build:dev -- --version 1.21.4 --port 25565 --origin 0,-60,90
```

自己的蓝图先做只读检查，再开始施工：

```bash
# 仅解析和检查，不连接 bot
npm run multi-build -- --schematic "/path/to/build.litematic" --inspect

# 最多 30 个 bot；此例指定蓝图包围盒最小角
npm run multi-build -- --version 1.21.4 --schematic "/path/to/build.litematic" --port 25565 --bots 30 --origin 0,-60,0

# 对有源原点信息的 Litematic，也可以指定真正的蓝图原点
npm run multi-build -- --version 1.21.4 --schematic "/path/to/build.litematic" --port 25565 --bots 30 --schematic-origin 128,0,128
```

两种原点不能同时传入：

| 参数 | 含义 |
| --- | --- |
| `--origin x,y,z` | 目标包围盒最小角 |
| `--schematic-origin x,y,z` | Litematica 源坐标系原点；程序根据 `sourceMin` 换算包围盒 |

换算公式为 `bboxOrigin = schematicOrigin + sourceMin`。例如源最小坐标为 `-27,-5,-26` 时，真正原点 `128,0,128` 对应包围盒最小角 `101,-5,102`。针对名称匹配 Mk6.1 的新施工，程序还要求真正原点三轴均为 16 的倍数；这不是所有蓝图的通用要求。悬空选址需要先准备可点击的基础支撑，不能直接假定任意高度都能开始。

常用参数：

| 参数 | 默认值或作用 |
| --- | --- |
| `--host` / `--port` | `127.0.0.1` / `25566`；必须与实际服务器一致 |
| `--version` | `1.21.11`；旧受管服显式指定 `1.21.4` |
| `--server-profile` | 已核验的外部本机 FIFO 控制台配置 |
| `--prepare-workers` | 配合 profile，仅准备本次在线施工 bot 的创造模式与 OP |
| `--bots` | `30`，范围 1–30 |
| `--prefix` | `builder`；更换后应确保对应账号的权限 |
| `--bottom-layers N` | 只建最低 N 个蓝图层，报告明确为部分施工 |
| `--max-attempts` | 每任务失败重试上限，默认 12 |
| `--resume <目录>` | 从同一蓝图、服务器、原点的施工记录恢复 |

调度器每次只派发当前最低层，每个 worker 同时最多执行一个任务。同层任务全部停止、目标复核和临时支撑清理完成后才进入下一层；失败、断线或未确认的世界操作会停止施工。辅助塔随当前层逐层加高，用完后拆除；不能为了重试回到较低层主动补放。

方块施工使用玩家操作，不通过 `/setblock`、`/fill` 或传送建造。创造材料的 `block_state` 组件保留可控放置属性；轨道等必要状态由真实调试棒交互校准。活塞头、流水和门的上半部等自然生成部分单独验证，不会因主动任务已结束就被假定完成。桶操作使用共享排他协调、服务端视图核对和原始方块更新确认，避免并发方块变化使点击落到其他层。

## 记录、续建与 checkpoint

每次运行写入 `.runtime/builds/<运行时间>/`：

- `inspection.json`：蓝图解析和支持情况。
- `events.jsonl`：任务、实际放置尝试、层屏障及确认事件。
- `status.json`、`report.json`：进度、失败原因及最终验证结果。

当前世界未回滚时，可以继续原记录：

```bash
npm run multi-build -- --version 1.21.4 --schematic "/path/to/build.litematic" --port 25565 --origin 0,-60,0 --resume ".runtime/builds/<运行时间>"
```

已完成低层只读复核，不重新放置；若这些层被破坏，续建会停止。恢复记录同时保存本次拥有的临时支撑，避免任意清理世界中的其他方块。`freshVerifiedBlocks` 表示本次新验收目标，仍可能包含已正确的方块；`placementAttempts` 包含失败尝试及支架，两者都不等于新放置成功数。

在身份校验通过的本项目冻结服务器 `25566` 或 clone `25567` 上，真实蓝图每层验收后会自动备份并生成 `build-checkpoint/`；fixture 和其他服务器不启用此功能。先完成本层动作和核验，再备份，成功后才升层。`checkpoint-complete` 事件给出准确的备份路径。

回滚时，必须先停止施工及服务器，**恢复该 checkpoint 对应的世界备份，再对其 `build-checkpoint/` 使用 `--resume`**。只传 `--resume` 不会恢复世界。主服使用 `scripts/server-backup.js`；clone 使用独立身份和备份流程，不能把两种世界恢复目录混用。保留失败世界和原记录，先用 `verify` 子命令校验备份。

## 验收与自然初始化

可对已刷盘的世界备份进行只读验收：

```bash
node scripts/audit-world.js --world "/path/to/backup/world" --schematic "/path/to/build.litematic" --origin 0,-60,0 --output "/path/to/new-audit.json"
```

该检查读取区域文件，核对目标方块、空气及比较器数据。容器、实体、自然生成状态和装置功能需要对应的额外验收。不要把冻结施工报告、静态方块匹配或单次自然状态匹配当作发射成功证明。

仓库还保留了逐 tick 初始化、隔离 clone、观察者 gate 和原版更新请求等实验工具。部分工具绑定特定主炮 SHA、坐标和 Minecraft 1.21.4，**不是通用的一键解冻流程**。观察者 `HOLD` 会临时改变观察者脉冲行为；`OFF` 才恢复原版处理。具体适用范围见 [发布范围与测试说明](docs/PUBLISHING.md) 和 [observer gate 说明](server-tools/observer-gate/README.md)。

## 开发与旧入口

```bash
npm test
npm run lint
npm run server:stop
```

CI 执行离线单元测试，不启动 Minecraft。实际官方 jar 缓存缺失时，observer gate 的 Java/字节码集成测试会明确跳过，不会自行下载 jar。单元测试通过不代表全部蓝图、版本或红石装置都能自动建造。

`node examples/builder.js` 是原单 bot 示例；`npm run multi-build:legacy` 是原多进程入口，不提供新入口的全局逐层保证。内置示例文件见 `schematics/`。

## 许可与上游

代码延续上游 `mineflayer-builder` 的 MIT 许可。保留 [LICENSE](LICENSE) 中 `Copyright (c) 2020 PrismarineJS` 及原 package 作者 Karang；本仓库在其基础上增加严格分层施工、物理执行、恢复和审计工具。Minecraft 服务端遵循 Mojang/Microsoft 的条款，运行时下载的服务端和用户世界不随仓库发布。
