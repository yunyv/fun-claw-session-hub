# Worker、OpenClaw 网关、Session Hub 任务、go-remote 的关系说明

这份文档只回答 3 个问题，而且尽量说人话：

1. **当前 Worker 和 OpenClaw 网关到底是什么关系**
2. **Session Hub 里“任务”到底是什么意思**
3. **当前 Worker 和 go-remote 到底有什么本质区别**

---

## 1. 先给一句最短结论

一句话先讲透：

> **OpenClaw Gateway 是真正干活的；Worker 只是它前面的“远程代办员”；Session Hub 里的任务，本质上是“让某台 Worker 去执行某个 OpenClaw 动作”的一张派工单；go-remote 则更像“远程跑 shell 命令”的工具。**

如果你只想先抓重点，就记住下面 4 句：

1. **Gateway 是执行者**
2. **Worker 是调用 Gateway 的代理层**
3. **Hub 里的任务 = 一次要派给 Worker 的结构化请求**
4. **go-remote 现在不是 Gateway 协议层，而是命令下发系统**

---

## 2. Worker 和 OpenClaw Gateway 是什么关系

## 2.1 谁是真正执行者

真正执行 OpenClaw 能力的，不是 Worker，而是 **OpenClaw Gateway**。

这个关系在现有说明里写得很明确：

- `Funclaw/实现方案2-session-hub版-精简版.md`
- `Funclaw/实现方案2-session-hub版.md`

实现上也很直接：

- `src/funclaw/worker/run.ts:30`
- `src/funclaw/worker/openclaw-client.ts:74`

`startFunclawWorker()` 做的事情不是自己执行模型，而是：

1. 连上 Hub
2. 接收 `task.assigned`
3. 根据任务类型，去调本机的 Gateway
4. 再把结果回给 Hub

所以 Worker 本质上不是“另一个 OpenClaw”，而是：

> **把远程任务翻译成对本机 Gateway 的调用。**

---

## 2.2 Worker 到底怎么调 Gateway

Worker 调 Gateway 目前固定走 3 个面：

### A. 文本 / 常规请求

Worker 调：

- `POST /v1/responses`

实现位置：

- `src/funclaw/worker/openclaw-client.ts:77`

也就是说，Hub 派给 Worker 一个 `responses.create` 任务后，Worker 实际上就是去 POST 本机 Gateway。

### B. 历史查询

Worker 调：

- `GET /sessions/{sessionKey}/history`

实现位置：

- `src/funclaw/worker/openclaw-client.ts:95`

### C. 节点能力调用

Worker 调 Gateway WebSocket：

- `node.invoke`

实现位置：

- `src/funclaw/worker/openclaw-client.ts:121`

比如截图、拍照、录屏这类能力，就不是走普通 HTTP，而是走 Gateway WS 能力面。

---

## 2.3 所以 Worker 和 Gateway 的关系可以怎么理解

你可以这样记：

| 角色 | 用人话解释 |
| --- | --- |
| `OpenClaw Gateway` | 真正会干活的人 |
| `OpenClaw Worker` | 接工单、跑腿、把活转交给 Gateway 的代理 |

也就是说：

- Gateway 负责执行
- Worker 负责接任务和转发

Worker 和 Gateway 不是平级替代关系，而是：

> **Worker 在 Gateway 前面加了一层“远程接入”和“协议转换”。**

---

## 2.4 为什么不让 Hub 直接调 Gateway

因为当前架构明确要求：

> **Hub 不直接碰 OpenClaw，本机调用必须由 Worker 来做。**

这样设计有几个好处：

### 1）Gateway 不必暴露给外部

文档里现在的目标一直是让 Gateway 收口在本机回环。

也就是：

```text
127.0.0.1:18789
```

或者现网隔离版本：

```text
127.0.0.1:18790
```

### 2）Hub 保持轻

Hub 只管：

- 接入
- 路由
- 状态登记
- 结果转发

不自己成为第二个 OpenClaw。

### 3）Worker 更接近运行现场

很多状态其实都在 OpenClaw 所在机器本地，比如：

- session 上下文
- 历史
- 临时文件
- 缓存
- 本地能力状态

让 Worker 贴着 Gateway，更合理。

---

## 3. Session Hub 里的“任务”到底是什么

## 3.1 先说人话定义

在 Session Hub 里，**任务** 不是“一个线程”或者“一个 Linux 进程”。

它更像：

> **一张派工单：告诉某台 Worker，请你替某个 session 去执行一次动作。**

这张派工单里面至少会带这些信息：

- 这是哪个请求 `request_id`
- 属于哪个会话 `session_id`
- 要派给哪台 Worker `worker_id`
- 这是哪个来源接进来的 `adapter_id`
- 要调用 OpenClaw 的哪个 session key
- 具体动作是什么
- 输入参数是什么

这个结构在协议里已经定义了：

- `src/funclaw/contracts/schema.ts:191`

对应的名字叫：

- `TaskAssignedPayload`

---

## 3.2 任务和 request 的关系

现在实现里，任务基本就是围绕 `RequestRecord` 在流转。

`RequestRecord` 定义在：

- `src/funclaw/contracts/schema.ts:277`

它里面有这些核心字段：

- `request_id`
- `session_id`
- `worker_id`
- `adapter_id`
- `action`
- `input`
- `status`
- `result`
- `artifacts`
- `error`

所以你可以把它理解成：

> **Hub 里真正被跟踪的一次“任务实例”，其实就是一条 request 记录。**

也就是说：

- 会话是长期的：`session_id`
- 任务是一次次发生的：`request_id`

一个 session 下面，可以连续产生很多任务。

---

## 3.3 任务是怎么生成出来的

### 情况 A：外部发消息进来

当调用：

- `POST /api/v1/sessions/:sessionId/messages`

Hub 会做这些事：

1. 先确认 session 存不存在
2. 不存在就建一个并绑定 Worker
3. 创建一条 request 记录
4. 把这条 request 派给对应 Worker

实现位置：

- `src/funclaw/hub/server.ts:295`
- `src/funclaw/hub/store.ts:150`
- `src/funclaw/hub/store.ts:182`

### 情况 B：Hub 自己发起历史查询

当调用：

- `GET /api/v1/sessions/:sessionId/history`

Hub 也不是直接查 Gateway。

它会：

1. 创建一条 `session.history.get` request
2. 派给绑定的 Worker
3. 等 Worker 回结果

实现位置：

- `src/funclaw/hub/server.ts:375`

所以“任务”并不只等于“用户发一条聊天消息”。

它其实是：

> **Hub 派给 Worker 的任意一种结构化动作。**

---

## 3.4 当前任务支持哪些动作

当前协议里，动作只有 3 种：

- `responses.create`
- `session.history.get`
- `node.invoke`

定义位置：

- `src/funclaw/contracts/schema.ts:137`

所以现在的任务不是无限制的，它不是“想干啥都能发”。

它是明确受控的 3 类任务：

| 动作 | 用途 |
| --- | --- |
| `responses.create` | 文本 / 常规对话执行 |
| `session.history.get` | 拉会话历史 |
| `node.invoke` | 调节点能力，比如截图、拍照、录屏等 |

---

## 3.5 任务的生命周期是什么

当前 request / 任务状态有这些：

- `queued`
- `running`
- `completed`
- `failed`
- `canceled`

定义位置：

- `src/funclaw/contracts/schema.ts:269`

你可以把它理解成下面这个过程：

```text
queued
  -> running
  -> completed
  或 failed
```

Hub 侧对应的方法大概是：

- `markAccepted()`：任务开始跑了
- `appendOutput()`：中途有输出
- `markCompleted()`：跑完了
- `markFailed()`：失败了

实现位置：

- `src/funclaw/hub/store.ts:212`
- `src/funclaw/hub/store.ts:220`
- `src/funclaw/hub/store.ts:227`
- `src/funclaw/hub/store.ts:237`

---

## 3.6 “任务”和“会话”的区别

这个最容易混。

你可以这么分：

### 会话 session

表示：

> 这是一条长期连续的对话 / 业务上下文。

关键字段：

- `session_id`
- `worker_id`
- `openclaw_session_key`

它的核心作用是：

- 记住这条会话归哪台 Worker

### 任务 request

表示：

> 在这条会话里，发起的一次具体动作。

比如：

- 让它回答一句话
- 拉一次历史
- 截一张图

所以：

> **session 是“线”，task/request 是“线上的某一个点”。**

---

## 4. 为什么 Session Hub 里一定要有任务这个概念

如果没有“任务”这个概念，Hub 就只能知道：

- 这个会话归哪台 Worker

但它不知道：

- 当前这次动作有没有收到
- 开始执行了没有
- 执行成功还是失败
- 有没有中间输出
- 有没有 artifact

任务这层的价值就是：

> **把一次会话里的每一次动作都单独记录、单独跟踪。**

这会让 Hub 能做这些事情：

- 查询 request 状态
- await 等待完成
- 失败重试或排障
- 事件通知 Adapter
- 跟踪 artifact

所以“任务”其实是 Hub 里最重要的运行单元之一。

---

## 5. 当前 Worker 和 go-remote 的区别到底是什么

这个问题本质上是在问：

> 为什么 Worker 不能直接用 go-remote 代替？

答案是：**它们长得像，但不是一类东西。**

---

## 5.1 共同点：它们都像“中间代理”

表面上看，两者都像“中间人”：

- 都会主动连出去
- 都会接收远端派过来的内容
- 都会在本机执行一些动作
- 都会把结果再回传

所以第一眼看，会觉得：

> go-remote agent 好像也能当 Worker。

但真正差别在下面。

---

## 5.2 本质区别一：Worker 调 API，go-remote 跑 shell

### Worker

Worker 是明确的 **Gateway 协议调用器**。

它直接调用：

- `/v1/responses`
- `/sessions/{sessionKey}/history`
- `node.invoke`

实现位置：

- `src/funclaw/worker/openclaw-client.ts:77`
- `src/funclaw/worker/openclaw-client.ts:95`
- `src/funclaw/worker/openclaw-client.ts:121`

### go-remote

go-remote 当前更像：

> 服务端发给 agent 一条 shell 命令，agent 在本机执行，然后把 stdout/stderr 回来。

在适配说明里已经总结过：

- `Funclaw/go-remote-session-hub-适配方案.md`

也就是说：

| 项目 | Worker | go-remote |
| --- | --- | --- |
| 本机动作方式 | 调 Gateway API / WS | 执行 shell 命令 |
| 输出形式 | 结构化 result / artifact | stdout / stderr / exit code |

---

## 5.3 本质区别二：Worker 懂任务协议，go-remote 不懂

Worker 连上 Hub 后，会按协议做这些事：

- `connect`
- `worker.heartbeat`
- `task.accepted`
- `task.output`
- `task.completed`
- `task.failed`
- `artifact.register`

可以从这两处看出来：

- `src/funclaw/worker/hub-client.ts:226`
- `src/funclaw/hub/server.ts:577`

这说明 Worker 是：

> **Hub 协议的一等公民。**

它知道：

- 什么叫 task
- 什么叫 accepted
- 什么叫 completed
- 什么叫 artifact

而 go-remote 当前协议更粗，主要是：

- 注册
- 发命令
- 回结果
- 心跳

它不理解 Session Hub 这套任务模型。

---

## 5.4 本质区别三：Worker 的结果是结构化的，go-remote 的结果偏命令行

Worker 跑完任务后，回 Hub 的不是单纯一段文本，而是：

- `result`
- `artifacts`
- `error`

并且任务状态会被落进 Hub 的 request 生命周期里。

而 go-remote 更像：

- 命令返回码
- 标准输出
- 标准错误

这两者的抽象层级不同。

你可以理解成：

- Worker 输出的是“业务结果”
- go-remote 输出的是“命令执行结果”

---

## 5.5 本质区别四：Worker 天然服务于 session sticky，go-remote 没这个核心能力

Worker 是围绕下面这张表设计的：

```text
session_id -> worker_id
```

也就是说，同一条会话会持续落到同一台 Worker 上。

这是 Session Hub 稳定性的核心。

而 go-remote 的核心路由更像：

- 把命令发给某个 client / agent

它不是围绕“会话粘性”设计的。

所以它更适合作为：

- 运维控制工具
- 外围桥接层

而不是直接替代 Worker。

---

## 6. 一个最实用的类比

如果你不想记抽象词，可以这样类比：

### OpenClaw Gateway

像 **后厨**

真正做菜的是它。

### Worker

像 **传菜员 + 前场执行员**

它负责：

- 接到单子
- 去后厨下单
- 把成品端回来

### Session Hub

像 **总调度台**

它负责：

- 接电话
- 记住哪桌一直由哪位服务员负责
- 追踪这张单现在做到哪一步了

### go-remote

像 **对讲机 + 远程喊话系统**

它擅长的是：

- 远程让某个人去跑个命令
- 听他回一句“跑完了，输出是啥”

但它本身不是这家餐厅的点单系统。

---

## 7. 最后再收成一句话

如果你现在要一句最短、最稳的理解：

> **Gateway 是干活的本体，Worker 是贴着 Gateway 的远程代理，Hub 里的任务是一张发给 Worker 的结构化工单，而 go-remote 更像远程命令执行工具，不是当前这套 Hub/Worker/Gateway 模型里的原生执行层。**

---

## 8. 如果你下一步想继续看源码，最值得看的文件

- `src/funclaw/worker/run.ts`
- `src/funclaw/worker/openclaw-client.ts`
- `src/funclaw/worker/hub-client.ts`
- `src/funclaw/hub/server.ts`
- `src/funclaw/hub/store.ts`
- `src/funclaw/contracts/schema.ts`
- `Funclaw/go-remote-session-hub-适配方案.md`
