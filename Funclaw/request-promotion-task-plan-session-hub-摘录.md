# External Agent Chat `request` 晋升为 `task`：Session Hub 侧摘录

> 来源文档：`Funclaw/request-promotion-task-plan(1).md`
> 摘录目的：只保留 **`fun-claw-session-hub` 仓库** 需要承担的修改项
> 当前判断时间：2026-04-22

## 1. 这份摘录怎么来的

原始任务单把工作分成了三块：

- `FunClaw API`
- `FunClaw Front`
- `Session Hub`

当前仓库 `fun-claw-session-hub` 的实际代码范围只有这些目录：

- `src/funclaw/contracts`
- `src/funclaw/hub`
- `src/funclaw/worker`

所以，这里只摘出原文 **第 5 节 Session Hub 精确改造点**，再补上少量和本仓库强相关的验收项与依赖说明。

## 2. 明确属于我们负责的范围

### 2.1 直接属于本仓库的修改

#### P0：必须先做

1. `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`

现状：

- `buildAgentResultFromHistory(...)` 现在只从 session history 里拼文本结果、tool call、tool result summary。

需要修改：

- 从 session history 中同时提取：
  - 文本结果
  - artifact 候选
- 新增 `NormalizeAgentArtifacts(...)` 或作用等价的 helper。

预期结果：

- `responses.create`
- `agent`

这两类 action 在 worker 侧不再只有文本摘要，还能产出标准化后的 artifacts。

补充：

- 原任务单写的仓库路径是 `fun-claw-session-hub-main/src/...`，在当前仓库中对应实际路径就是：
  - `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`

---

2. `src/funclaw/worker/cmd/go-worker/main.go`

现状：

- `responses.create` 分支当前只调用 `gateway.CallAgent(...)` 并回传 `result`
- `agent` 分支也是同样处理
- `node.invoke` 已经有 artifact 注册思路，可作为参照

需要修改：

- 在 `responses.create` 分支中，参照 `node.invoke` 的处理方式，对 agent artifacts 逐个执行 `artifact.register`
- 在 `agent` 分支中做同样的 artifact 注册流程

预期结果：

- `task.completed.artifacts` 能带出 agent 产物
- `responses.create` 和 `agent` 的表现保持一致

---

3. `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`

需要修改：

- 明确支持从这些来源识别 artifact：
  - assistant 内容块
  - tool result
  - OSS / 外链描述

预期结果：

- 会话式 Agent 产出的文件、图片，能被 worker 识别出来并转成 Hub artifact

当前建议：

- 如果当前只能拿到远程 URL，P0 先采用“worker 二次下载后再注册”的办法

---

4. `src/funclaw/worker/internal/hubclient/hubclient.go`

现状：

- `task.assigned` 到来后，当前是 `go func()` 并发处理

需要修改：

- 对同一 `openclaw_session_key` 或同一 `session_id` 做串行化处理

预期结果：

- 同一会话下多次 request 连续到来时，避免并发污染 session history

这项很关键，因为当前实现天然允许并发执行。

---

5. `src/funclaw/worker/run.test.ts`

现状：

- 现有测试重点在 `node.invoke` 的 artifact 场景

需要修改：

- 补 `responses.create`
- 补 `agent`
- 补“带 artifact”的集成测试

测试至少覆盖：

- `inline`
- `hub_file`

预期结果：

- request 完成后，artifacts 可以被查询
- artifact 内容可以被下载

### 2.2 P1：可以后排

#### 1. `src/funclaw/contracts/schema.ts`

需要修改：

- 如果后面不想让 worker 二次下载远程 URL，可以扩展新的 transport，例如：
  - `remote_url`
  - 更完整的 `object_store`

预期结果：

- Hub 可以保存远程引用，而不是总要转成 base64 或本地文件

备注：

- 这项不是当前 P0 的前置条件

#### 2. `src/funclaw/hub/server.ts`
#### 3. `src/funclaw/hub/store.ts`

需要修改：

- 如果后续扩展了新的 artifact transport，那么这里也要一起支持：
  - artifact meta
  - artifact content 读取

预期结果：

- 远程大文件可以用引用方式返回

备注：

- 这是第二阶段内容，当前版本可以先不动

## 3. 明确不属于我们负责的范围

以下内容在原任务单里有写，但不在当前仓库中：

### 3.1 `FunClaw API`

对应原文第 3 节，主要涉及：

- `ChatService`
- `SessionHubClientService`
- `ArtifactStorageService`
- `MessageRepository`

这部分负责“`request` 什么时候晋升为 `task`、如何补建 task / execution、如何把 Hub artifact 复制进平台存储”。

### 3.2 `FunClaw Front`

对应原文第 4 节，主要涉及：

- 消息分类
- 任务卡片显示
- 资产页联动

这部分负责“已经晋升的消息怎样按任务卡片展示”。

## 4. 我们这一侧真正要交付什么

用一句话说：

> 让 Session Hub 这条链路，能够把 `responses.create/agent` 产出的文件类结果真正挂到 `request.artifacts` 上。

拆开后就是四件事：

1. worker 能从 OpenClaw session history 中识别出 artifact
2. worker 能把 artifact 注册到 Hub
3. Hub 返回的 `task.completed.artifacts` 结构稳定可消费
4. 同一会话并发请求时，history 不会互相串掉

## 5. 建议按这个顺序做

### 第一步：改 `gatewayclient.go`

先把 agent 结果抽取补完整：

- 文本
- artifact 候选
- 标准化 helper

### 第二步：改 `main.go`

把 `responses.create` 和 `agent` 两个分支的 artifact 注册打通。

### 第三步：改 `hubclient.go`

补同一 session 的串行处理。

### 第四步：补测试

把集成测试补齐，至少覆盖：

- 纯文本
- 单个 inline artifact
- 单个 hub_file artifact
- 同一 session 连续请求

## 6. 我们这一侧的完成标准

只看 `session-hub` 仓库，本次完成标准可以写成下面几条：

1. `responses.create` 成功后，如果历史记录里含有文件或图片，Hub 返回的 request 中带 `artifacts`
2. `agent` 成功后，如果历史记录里含有文件或图片，Hub 返回的 request 中带 `artifacts`
3. `inline` 类型 artifact 可以查询并读取内容
4. `hub_file` 类型 artifact 可以查询并读取内容
5. 同一个 `openclaw_session_key` 下连续发送多个 request，不会因为并发把结果串到一起

## 7. 和其他仓库的接口边界

我们这边做完后，应该给 `fun-claw-api` 的输出信号是：

- `request.result` 里仍保留文本结果
- `request.artifacts` 里补齐产物列表
- artifact 内容接口可正常读取

后面的事由对方处理：

- 是否把这个 request 晋升成 task
- 是否把 artifact 复制到平台存储
- 前端把消息渲染成普通气泡还是任务卡片

## 8. 原任务单与当前仓库路径对照

| 原任务单写法 | 当前仓库实际路径 |
| --- | --- |
| `fun-claw-session-hub-main/src/funclaw/worker/internal/gatewayclient/gatewayclient.go` | `src/funclaw/worker/internal/gatewayclient/gatewayclient.go` |
| `fun-claw-session-hub-main/src/funclaw/worker/cmd/go-worker/main.go` | `src/funclaw/worker/cmd/go-worker/main.go` |
| `fun-claw-session-hub-main/src/funclaw/worker/internal/hubclient/hubclient.go` | `src/funclaw/worker/internal/hubclient/hubclient.go` |
| `fun-claw-session-hub-main/src/funclaw/worker/run.test.ts` | `src/funclaw/worker/run.test.ts` |
| `fun-claw-session-hub-main/src/funclaw/contracts/schema.ts` | `src/funclaw/contracts/schema.ts` |
| `fun-claw-session-hub-main/src/funclaw/hub/server.ts` | `src/funclaw/hub/server.ts` |
| `fun-claw-session-hub-main/src/funclaw/hub/store.ts` | `src/funclaw/hub/store.ts` |
