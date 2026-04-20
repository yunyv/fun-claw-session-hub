# fun-claw-session-hub

从 OpenClaw 抽出来的独立 Session Hub / Worker 验证仓库。

Included paths:
- Funclaw
- src/funclaw
- src/cli/funclaw-cli

Session Hub docs:
- `Funclaw/session-hub-接口文档.md`
- `Funclaw/funclaw-hub.openapi.yaml`

## 当前状态

- `src/funclaw/hub`：Hub HTTP / WebSocket 服务
- `src/funclaw/worker`：新的 Go worker 子工程
- `src/funclaw/worker/run.ts`：给现有 TypeScript 侧保留的启动桥，负责本地 `go build` 后拉起 Go worker

## 安装

```bash
bun install
```

## 测试

```bash
bun run test
```

这会做两层验证：

1. 跑 TypeScript 侧测试，包含一个真的 Hub -> Go worker -> Gateway stub 端到端链路
2. 跑 Go worker 自己的 `go test ./...`
