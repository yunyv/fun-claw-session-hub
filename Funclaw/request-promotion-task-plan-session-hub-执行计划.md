# Session Hub `request -> task` 改造执行计划

> 适用对象：一个 **没有上下文** 的 Codex
> 仓库：`/home/yunyv/test-projects/Fenxing/fun-claw-session-hub`
> 目标：只完成 `session-hub` 仓库这一侧的改造，不碰 `fun-claw-api` 和 `fun-claw-front`
> 参考文档：
> - `Funclaw/request-promotion-task-plan(1).md`
> - `Funclaw/request-promotion-task-plan-session-hub-摘录.md`

## 1. 任务目标

本次只做一件事：

> 让 `responses.create` 和 `agent` 这两类 request，在 OpenClaw 会话历史中出现文件或图片结果时，能够把产物挂到 Hub 的 `request.artifacts` 上。

最终要达到的效果：

- 纯文本回复：仍然只有文本结果
- 带图片或文件的回复：`task.completed.artifacts` 非空
- Hub 现有 artifact 查询和内容下载接口继续可用
- 同一个 `openclaw_session_key` 下连续请求时，不会因为并发把 history 串掉

## 2. 本次只允许改动的范围

### 2.1 主要改动文件

1. `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`
2. `src/funclaw/worker/cmd/go-worker/main.go`
3. `src/funclaw/worker/internal/hubclient/hubclient.go`
4. `src/funclaw/worker/run.test.ts`

### 2.2 原则上先不改的文件

1. `src/funclaw/contracts/schema.ts`
2. `src/funclaw/hub/server.ts`
3. `src/funclaw/hub/store.ts`

备注：

- 上面 3 个文件只有在你确认当前 P0 实现被它们卡住时，才允许继续动。
- 当前目标优先复用现有 `inline` 和 `hub_file` 机制。

### 2.3 明确不要碰的范围

1. `fun-claw-api`
2. `fun-claw-front`
3. 任何和“什么时候晋升为 task”有关的产品逻辑

这些不属于本仓库。

## 3. 开工前先读的文件

按这个顺序读，读完再写代码：

1. `Funclaw/request-promotion-task-plan-session-hub-摘录.md`
2. `src/funclaw/worker/cmd/go-worker/main.go`
3. `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`
4. `src/funclaw/worker/internal/hubclient/hubclient.go`
5. `src/funclaw/worker/run.test.ts`
6. `src/funclaw/hub/server.ts`

## 4. 当前代码现状

### 4.1 `node.invoke` 已经有完整的 artifact 路径

`src/funclaw/worker/cmd/go-worker/main.go`

当前 `node.invoke` 的流程已经是：

1. 调 `gateway.InvokeNode(...)`
2. 用 `gateway.NormalizeNodeArtifacts(...)` 拆出 `normalizedResult` 和 `normalizedArtifacts`
3. 逐个调用 `hub.RegisterArtifact(...)`
4. 把注册后的 `artifacts` 带进 `hub.SendCompleted(...)`

这条路径是本次最重要的参照实现。

### 4.2 `responses.create` 和 `agent` 当前只有文本结果

还是在 `src/funclaw/worker/cmd/go-worker/main.go`：

- `responses.create` 现在只是 `gateway.CallAgent(...) -> result = res`
- `agent` 也是同样处理
- 这两条分支现在没有 artifact 标准化和注册逻辑

### 4.3 Agent 结果目前来自 session history

`src/funclaw/worker/internal/gatewayclient/gatewayclient.go`

`CallAgent(...)` 当前做法：

1. 先调用 Gateway WS `agent`
2. 再轮询 `agent.wait`
3. 最后用 `buildAgentResultFromHistory(...)` 从会话历史里提取最终文本

当前 `buildAgentResultFromHistory(...)` 只提取：

- `payloads[].text`
- `tool_calls`
- `tool_results_summary`

现在还没有产物提取。

### 4.4 同一 session 当前是并发处理

`src/funclaw/worker/internal/hubclient/hubclient.go`

`task.assigned` 事件到了以后，当前是 `go func()` 直接起一个协程去跑 `OnTaskAssigned(...)`。

这意味着：

- 同一个 `session_id`
- 或同一个 `openclaw_session_key`

如果短时间收到多个 request，会并发进入 Gateway，存在污染会话历史的可能。

### 4.5 现有端到端测试已经有 Gateway stub

`src/funclaw/worker/run.test.ts` 已经提供了这些基础设施：

- Hub 真服务
- Go worker 真进程
- Gateway stub
- request await
- artifact 查询和内容下载

当前它已经覆盖：

- `responses.create`
- `session.history.get`
- `node.invoke`

但 `responses.create` 现在只断言文本结果，没有覆盖 artifact 场景。

## 5. 具体执行步骤

## 第一步：在 `gatewayclient.go` 补 agent artifact 抽取

目标：

- 新增一个和 `NormalizeNodeArtifacts(...)` 类似的能力
- 从会话历史中同时拿到：
  - 文本结果
  - artifact 候选

建议做法：

1. 保留 `CallAgent(...)` 现有主流程
2. 把 `buildAgentResultFromHistory(...)` 改成返回两部分内容，或者新增一层 helper
3. 新 helper 的职责要清楚：
   - 输入：history items 或 history-derived result
   - 输出：`(normalizedResult, normalizedArtifacts)`

识别 artifact 时优先看这些来源：

1. assistant 内容块
2. tool result 内容块
3. 已经是 base64 的图片或文件字段
4. 文本中描述出来的 OSS / 外链

当前 P0 的现实要求：

- 优先先把“能直接拿到内容”的 artifact 路径做通
- 如果只有远程 URL，允许先采用“worker 再下载一遍，再注册 artifact”的方案

实现要求：

- 返回给 Hub 的 `result` 里仍然保留现有文本结构
- 新增的 artifact 提取不能破坏现有 `tool_calls` 和 `tool_results_summary`

## 第二步：在 `main.go` 给 `responses.create` 和 `agent` 接入 artifact 注册

目标：

- 让 `responses.create`
- 让 `agent`

都复用 `node.invoke` 的 artifact 注册流程。

建议改法：

1. 把现在 `node.invoke` 分支里“标准化 + 注册 artifact”的逻辑抽成一个共用 helper
2. `responses.create` 和 `agent` 调完 `gateway.CallAgent(...)` 后，调用新的 agent artifact 标准化函数
3. 逐个执行 `hub.RegisterArtifact(...)`
4. 最终把 `artifacts` 一并交给 `hub.SendCompleted(...)`

代码目标：

- 三条 action 的 artifact 处理风格尽量统一
- 避免把同一段注册逻辑复制三份

## 第三步：在 `hubclient.go` 对同一 session 做串行化

目标：

- 同一个 `openclaw_session_key`
- 或同一个 `session_id`

同一时刻只允许一个 task 在 worker 里执行。

建议改法：

1. 在 `HubClient` 内增加一个按 key 排队的结构
2. `task.assigned` 到来时，不再裸起 `go func()`
3. 先计算串行 key
4. 把任务放进这个 key 对应的串行队列中执行

串行 key 的建议优先级：

1. `openclaw_session_key`
2. `session_id`
3. `request_id`

这样做的原因：

- 本次问题的根源是会话历史共享，不是全局 worker 资源竞争
- 所以只要同一会话串行，不同会话仍可并发

## 第四步：补端到端测试

在 `src/funclaw/worker/run.test.ts` 里至少补这 4 类用例：

1. `responses.create` 纯文本结果
2. `responses.create` 返回 `inline` artifact
3. `responses.create` 返回 `hub_file` artifact
4. 同一 `sessionKey` 连续提交两个 request，验证不会串结果

如果时间够，再补：

1. `agent` 返回 `inline` artifact
2. `agent` 返回 `hub_file` artifact

测试实现建议：

- 继续复用现有 `startGatewayStub()`
- 在 stub 的 session history 返回值里加新的 content block 或 tool result 结构
- 让 artifact 场景能稳定地产生：
  - 小文件，触发 `inline`
  - 大文件，触发 `hub_file`

## 6. 修改时必须遵守的约束

1. 不要重写 Hub HTTP 协议
2. 不要修改 `request`、`artifact` 的主数据模型含义
3. 不要为了图省事，把所有 request 都强制变成 artifact 场景
4. 不要加静默降级逻辑来掩盖解析失败
5. 不要跳过测试

如果历史里没有识别出 artifact，就保持现有纯文本行为。

## 7. 交付标准

完成时，至少满足下面这些条件：

1. `responses.create` 有文件或图片时，`request.artifacts` 非空
2. `agent` 有文件或图片时，`request.artifacts` 非空
3. `request.result.payloads[].text` 仍然正常返回
4. `GET /api/v1/artifacts/{id}` 可以查到元数据
5. `GET /api/v1/artifacts/{id}/content` 可以读到内容
6. 同一 session 的连续请求不会互相串结果
7. 现有 `node.invoke` 场景测试继续通过

## 8. 本地验证命令

在仓库根目录执行：

```bash
bun run test:ts
```

然后执行：

```bash
bun run test:go
```

最后执行完整检查：

```bash
bun run test
```

如果只想先盯住端到端测试，先跑：

```bash
bun x vitest run src/funclaw/worker/run.test.ts
```

## 9. 交付时需要汇报的内容

提交结果时请明确写出：

1. 修改了哪些文件
2. 每个文件改了什么
3. 新增了哪些测试
4. 跑了哪些命令
5. 哪些问题已经解决
6. 还有哪些点你故意留到第二阶段

## 10. 第二阶段内容，本次先不要做

下面这些内容可以记录在结果里，但本次先不要展开：

1. 在 `src/funclaw/contracts/schema.ts` 增加 `remote_url` 一类的新 transport
2. 在 `src/funclaw/hub/server.ts` 和 `src/funclaw/hub/store.ts` 里增加远程引用型 artifact 支持
3. 对 `fun-claw-api` 增加 artifact 回源复制和 request 晋升逻辑
4. 对 `fun-claw-front` 增加任务卡片展示

## 11. 一句话版本

先把 `agent` 的结果从“只有文本”改成“文本 + 可注册产物”，再让 worker 把这些产物按现有 Hub artifact 机制交出去，同时把同一 session 的任务改成串行执行，最后补齐端到端测试。
