# 发布范围与复现说明

公开仓库：<https://github.com/Tlingxie/mineflayer-cannon-builder>，默认分支 `main`。

这是源码导出，保留上游 MIT 归属，不包含本机世界、RCON 凭据、玩家数据、服务器二进制、历史运行日志或私人绝对路径。`.runtime/`、`node_modules/` 和缓存不应提交。

## 包与 CI

- `package.json` 保留 `mineflayer-builder` 名称和 `file:.` 自依赖，以兼容旧示例；`private: true` 禁止误发 npm。
- 提交 `package-lock.json`，使用 `npm ci` 复现依赖。Mineflayer 与 pathfinder 固定到实服使用的提交，并通过 HTTPS 安装；其他依赖保留原有版本范围。
- CI 使用 Node.js 22/24、Java 21，运行 `npm ci` 和 `npm test`。不启动服务、不构建真实世界，不继承自动 npm 发布工作流。
- 首次启动本地服务须由使用者显式执行 `npm run server:start -- --accept-eula`。npm 脚本不再默认代为接受 EULA。

## 测试边界

常规测试使用临时目录、模拟服务器响应和协议事件。测试中出现 `.runtime/server`、`.runtime/clones` 等路径，通常用于身份校验 fixture，不需要现有世界。

`test/observerGate.test.js` 是可选集成测试：需要 `.runtime/server/versions/1.21.4/server-1.21.4.jar`、对应 ASM 库及 Java 21。缺少官方 jar 时会明确 `skip`，不访问网络下载。干净 checkout 的 CI 因此不覆盖实际 Minecraft 字节码变换；本地具备依赖后可单独运行：

```bash
node --test test/observerGate.test.js
```

依赖本机私有 `.runtime/pulse-aligned-buttons.js` 的测试未随导出保留。固定个人源路径或旧进程身份的 aligned 初始化、验收、静止检查、release 脚本及对应测试也未导出；不要将其缺失理解为完整实服终验流程已通用化。

## 保留的专项工具

以下文件保留用于研究和测试，但仍有明确的案例约束：

| 文件 | 约束 |
| --- | --- |
| `scripts/initialize-server.js` | 固定主炮源 SHA、完整目标数量、原点 `64,-60,0` 和 managed 主服端点 |
| `scripts/initialize-clone.js`、`lib/naturalInitialization.js` | 固定 managed clone 身份与案例区块加载范围；只表示指定 tick 步进已执行并通过防护 |
| `scripts/audit-construction-order.js` | 对齐主炮的源 SHA、`128,0,128` 真正原点、51 层与基础支撑审计约束 |
| `scripts/request-vanilla-updates.js`、`server-tools/observer-gate/allowlist.txt` | 固定源 SHA 和明确坐标白名单，不是任意世界更新 API |
| `server-tools/observer-gate/` | 仅适配 SHA 校验通过的官方 1.21.4 类文件；需要 Java 21，控制模式和拦截行为均有记录 |
| `scripts/restart-construction-clone.js` | 只接受校验通过的 managed clone 备份和当前进程身份，保留旧世界；不能替代用户世界迁移规划 |

不要为了适配另一份蓝图，仅删除身份、坐标或哈希守卫后直接运行这些运维工具；先修改计划和对应测试，明确实际操作范围。

## 内容与结果范围

仓库未提供主炮、下界加载器和控制面板蓝图。`schematics/` 是原项目保留的示例。用户自己的蓝图、世界和操作记录需自行提供与保存。

严格逐层施工、原始方块 ACK、容器和实体检查分别提供不同证据。自然初始化可能触发观察者脉冲、活塞移动和物品运输，完整装配验收不等于发射验收。当前传送门物品循环故障尚未解决，不能将本次源码发布描述为整套装置已通过功能测试。

公开前可复查：

```bash
git status --short
git ls-files .runtime node_modules
npm ci
npm test
```

第二条命令应无输出。保留 `LICENSE`，提交依赖锁，并避免把本机日志、备份或凭据追加到示例和文档。
