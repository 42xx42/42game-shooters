# 42game-shooters

[![Linux.do](https://img.shields.io/badge/Linux.do-community-0EA5E9?logo=discourse&logoColor=white)](https://linux.do)
[![在线体验](https://img.shields.io/badge/在线体验-game.42w.shop-22C55E?logo=googlechrome&logoColor=white)](https://game.42w.shop)

[English README](./README.en.md)

`42game-shooters` 是基于上游项目 [`jay6697117/shooters`](https://github.com/jay6697117/shooters) 的二次开发开源版本，继续沿用 [MIT License](./LICENSE)。

这个仓库保留了继续开发和部署所需的核心内容：前端游戏逻辑、Node.js 服务端、资源文件、PVP 相关脚本与测试；同时移除了本地工具目录、缓存、构建产物和历史运行数据。

感谢 Linux.do 社区在测试、反馈和讨论中的支持。

在线体验：<https://game.42w.shop>

## 项目简介

当前版本包含以下主要能力：

- 3D 卡通射击游戏前端，入口页面为 `index.html`
- Node.js 服务端与后台页面
- PVP 对战模式，包含 `duel` 与 `deathmatch`
- 观战、回放与赛事面板相关能力
- Linux.do 登录、后台管理、奖励 / CDK 相关接口
- 42 杯活动相关配置与排行榜逻辑

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
- `npm run test:pvp`：验证 PVP 核心与房间能力
- `npm run test:security`：验证历史奖励相关回归场景

## 环境变量

请以 `.env.example` 为准。当前主要配置包括：

- `HOST`、`PORT`、`BASE_URL`：服务监听与基础地址
- `LINUX_DO_CLIENT_ID`、`LINUX_DO_CLIENT_SECRET` 等：Linux.do OAuth 登录配置
- `ADMIN_LINUX_DO_USERNAMES`：后台管理员用户名
- `ALLOW_CLIENT_REPORTED_AWARDS`：是否允许客户端上报奖励
- `PVP_EDGE_BASE_URL`、`PVP_EDGE_SHARED_SECRET` 等：PVP 边缘校验与令牌配置

## 目录结构

- `assets/`：游戏资源文件
- `src/`：前端逻辑
- `server/`：服务端逻辑
- `scripts/`：测试与校验脚本
- `data/`：运行时数据目录

其中 `data/*.json`、`output/`、`node_modules/` 等内容已在 `.gitignore` 中排除，不会进入仓库。

## 开源说明

- 本项目是上游仓库的二次开发版本，请保留对上游项目的来源说明
- 本仓库继续沿用 MIT 许可证，分发时请保留 [LICENSE](./LICENSE)
- 当前公开版本已经移除本地开发工具目录、缓存目录、输出目录和历史运行数据
