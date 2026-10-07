# Minecraft 1.21.11

严格施工入口默认连接 `127.0.0.1:25566`，协议版本 `1.21.11`。保留 30 个真实在线 bot、飞行靠近后逐块交互、全局 Y 层屏障及放置日志。`--version 1.21.4` 仍可用于旧世界；跨版本不能复用原来的续建记录。

## 连接已有本机服务器

需要 Node.js 22+、Java 21，以及已经运行的 1.21.11 服务。施工 bot 使用离线账号，需要服务器允许离线连接、创造模式和飞行；调试棒还需要 OP。接入不会启动、停止、冻结服务器，也不会改变它的默认游戏模式。

如果服务器的标准输入连接到 FIFO、标准输出或错误输出写入本机日志，可以自动生成独立的运行身份配置：

```bash
npm run server:attach
```

该命令核对监听进程、启动时间、工作目录、FIFO、日志以及实际 Minecraft 版本，把配置保存在 `.runtime/servers/1.21.11-25566.json`。服务器重启后需重新执行。需要 `lsof` 和 `ps`；此控制台适配用于 macOS/Linux。配置属于本机运行文件，不应提交到 Git。

先选择有完整地面的空地，运行三层、180 个方块的小样：

```bash
npm run multi-build:dev -- \
  --server-profile .runtime/servers/1.21.11-25566.json \
  --prepare-workers --prefix cannon --origin 256,64,256
```

`--prepare-workers` 只对这次成功上线、用户名及 UUID 匹配的施工 bot 授予 OP 并设置创造模式。它不修改其他在线玩家，也不修改全服默认游戏模式。省略此选项时，需要预先准备好施工账号的权限。施工结束 bot 会退出；施工账号的 OP 会保留以供后续任务使用。

已自行设置好权限的服务器也可以不使用控制台配置：

```bash
npm run multi-build:dev -- --host 127.0.0.1 --port 25566 --version 1.21.11 --origin 256,64,256
```

这种模式通过玩家视图和 GUI 验证普通方块、容器，无法为依赖冻结证明的封闭矿车或流体操作提供完整的服务器验证。

## 实际蓝图

```bash
npm run multi-build -- --schematic /path/to/build.litematic --inspect

npm run multi-build -- \
  --schematic /path/to/build.litematic \
  --server-profile .runtime/servers/1.21.11-25566.json \
  --prepare-workers --prefix cannon --schematic-origin 128,0,128
```

坐标示例必须按实际世界选择。`--schematic-origin` 是蓝图原点，`--origin` 是包围盒最小角。已有目标会被只读核对；不要在未经核对的现有建筑上开始施工。

主炮的封闭矿车装配、流体隔离及比较器输出验收仍要求服务器 tick 已冻结且游戏时间停止推进。程序只检查冻结状态，不会自动冻结正在使用的服务器。外部控制台只读后端使用 `tick query`、`time query`、`data get` 及方块谓词验证，不使用命令放置方块。

外部服务器生成正常施工日志和续建记录，但不会调用旧 1.21.4 管理目录的逐层世界备份。世界备份需由该服务器自己的运维流程完成。

## 协议适配与范围

- 创造槽：根据实际协议定义将组件编码为 `UntrustedSlot` 所需的二进制，保留本地 Item 的结构化组件。
- 容器点击：空槽编码为 `null`；对 `damage`、`repair_cost`、`max_damage`、`max_stack_size` 计算 HashOps INT 的 CRC32C。未知组件的点击哈希明确报错，避免静默丢失属性。
- 容器内容继续通过重新打开 GUI 或服务器只读快照核对；客户端预测不作为最终验收。
- 1.21.4 的协议分支保持原行为。旧 observer gate、克隆服初始化、历史装配证明没有移植到 1.21.11，不能在新服务器上套用旧 JAR 或操作记录。

协议与兼容性来源：[Minecraft 1.21.11 协议定义](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.11/protocol.json)、[Mineflayer 容器协议修复讨论](https://github.com/PrismarineJS/mineflayer/pull/4027)、[prismarine-item HashOps 实现及测试向量](https://github.com/PrismarineJS/prismarine-item/pull/184)。项目使用小范围本地适配，不依赖未合并的上游分支。

本版本适配不等于整座轨道炮已通过发射测试。此前传送门物品循环问题仍需要独立功能验证。

## 2026-10-07 实服验证

在原版 1.21.11 的 `127.0.0.1:25566` 完成以下测试，服务器全程正常 tick，未重启或冻结：

- 30 个 bot 同时连接且全部实际参与施工，峰值并发 30。
- 在 `256,64,256` 开始的三层小样共放置 180 个目标，Y=64、65、66 各 60 个；逐动作日志确认每层验收完成才开始上一层。
- 施工阶段 5.541 秒，含登录及飞到工地共 31.558 秒。该数据是小样实测，不代表完整主炮的速度。
- 单 bot 另验证了活塞朝向、顶半砖、动力铁轨、调试棒，以及桶内剪刀的损耗/维修费用组件和物品数量；容器通过重新打开 GUI 与控制台只读快照双重核对。
- 测试 bot 完成后退出；原有 41 个在线玩家/bot 继续运行。
