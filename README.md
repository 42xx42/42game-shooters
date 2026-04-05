# 42game-shooters

[![Linux.do](https://img.shields.io/badge/Linux.do-community-0EA5E9?logo=discourse&logoColor=white)](https://linux.do)
[![在线体验](https://img.shields.io/badge/在线体验-game.42w.shop-22C55E?logo=googlechrome&logoColor=white)](https://game.42w.shop)

[English README](./README.en.md)

`42game-shooters` 是基于上游项目 [`jay6697117/shooters`](https://github.com/jay6697117/shooters) 的二次开发开源版本，继续沿用 [MIT License](./LICENSE)。

当前公开仓库保留了继续开发和部署所需的核心内容：前端游戏逻辑、Node.js 服务端、后台页面、资源文件、PVP 相关脚本与测试；同时移除了本地工具目录、缓存、构建产物、历史运行数据和其他不适合公开上传的内容。

感谢 Linux.do 社区在测试、反馈和讨论中的支持。

在线体验：<https://game.42w.shop>

## 当前公开能力

- 3D 卡通射击网页前端，主入口为 `index.html`
- Node.js 服务端与后台管理页 `admin.html`
- PVE + 在线 PVP 双线能力，PVP 当前支持 `duel` 与 `deathmatch`
- 房间码加入、匹配、观战、回放查看、赛事面板与排行榜能力
- Linux.do OAuth 登录、管理员配置、奖励策略与 CDK 相关接口
- 手机浏览器可玩：触屏设备会自动切换到移动 HUD，保留左手移动、右手转向、开火 / 换弹 / 闪避 / 切枪 / 手雷等触控操作

## 手机端说明

- 手机版默认指“手机浏览器可玩的网页版本”，不是原生 App
- 触屏 + 窄屏设备会自动进入移动模式，桌面端鼠标键盘流程保持不变
- 战斗界面采用“横屏优先”策略；移动端在战斗中竖屏会显示横屏提示，避免遮挡视野
- 移动 HUD 已适配安全区 `env(safe-area-inset-*)`

## 奖励与公开版边界

- 当前默认配置更偏保守，`ALLOW_CLIENT_REPORTED_AWARDS=false`
- 公开版默认不鼓励继续依赖“客户端自报结果即可自动发码”的旧逻辑，而是优先服务端记录与后续校验能力
- 运行时数据、对局历史、回放文件等内容会生成在 `data/` 下，这些文件不属于仓库内容

## 快速开始

1. 准备可用的 Node.js 环境
2. 参考 `.env.example` 创建 `.env`
3. 按需填写环境变量
4. 运行：

```bash
node server.mjs
```

也可以直接使用：

```bash
npm run dev
```

默认监听地址见 `.env.example`，当前默认值为 `http://127.0.0.1:4173`。

首次启动时，程序会自动补齐 `data/` 下需要的运行时文件。

## 常用脚本

- `npm run start`：启动服务
- `npm run dev`：本地开发启动
- `npm run test:auth`：验证登录 / 发码链路
- `npm run test:pvp`：验证 PVP 核心、房间与实时战斗流程
- `npm run test:security`：验证历史奖励相关回归场景

## 环境变量

请以 `.env.example` 为准。当前主要配置包括：

- `HOST`、`PORT`、`BASE_URL`：服务监听与基础地址
- `LINUX_DO_CLIENT_ID`、`LINUX_DO_CLIENT_SECRET` 等：Linux.do OAuth 登录配置
- `ADMIN_LINUX_DO_USERNAMES`：后台管理员用户名
- `ALLOW_CLIENT_REPORTED_AWARDS`：是否允许客户端上报奖励结果，默认建议保持关闭
- `PVP_EDGE_BASE_URL`、`PVP_EDGE_SHARED_SECRET` 等：PVP 服务端校验与令牌配置

## 部署提示

- 对外部署时，通常需要让反向代理把 `/api/*` 和 WebSocket 流量正确转发到 Node 服务
- `BASE_URL` 应设置为实际对外访问的网页地址
- 不要把 `.env`、`data/`、回放文件、运行日志或任何用户数据提交到仓库

## 目录结构

- `index.html`：游戏主入口
- `admin.html`：后台入口
- `assets/`：游戏资源文件
- `src/`：前端逻辑
- `server/`：服务端逻辑
- `scripts/`：测试与校验脚本
- `data/`：运行时数据目录，首次启动后自动生成

其中 `data/*.json`、`data/pvp-replays/`、`output/`、`node_modules/` 等内容已在 `.gitignore` 中排除，不会进入仓库。

## 开源说明

- 本项目是上游仓库的二次开发版本，请保留对上游项目的来源说明
- 本仓库继续沿用 MIT 许可证，分发时请保留 [LICENSE](./LICENSE)
- 当前公开版本已经移除本地开发工具目录、缓存目录、输出目录和历史运行数据
