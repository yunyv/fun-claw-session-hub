# fun-claw-session-hub

从 OpenClaw 抽出来的独立 Session Hub / Worker 验证仓库。

## 仓库结构

- `docs/api`：Session Hub 接口文档
- `docs/design`：方案稿和精简版方案
- `docs/plans`：执行计划与任务摘录
- `docs/ops`：本机运维记录，使用 `.local.md` 后缀，默认不提交
- `src/funclaw`：Hub、契约和 Worker 主代码
- `src/cli/funclaw-cli`：本仓库 CLI 入口
- `skills`：OpenClaw 运行时 skill
- `.agents`：给 Codex 用的仓库内说明
- `workspace`：本机 IDE 工作区文件，默认不提交

Session Hub docs:
- `docs/api/session-hub-接口文档.md`
- 当前仓库还没有 `funclaw-hub.openapi.yaml`；如果后续补上，建议放在 `docs/api/`

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
