# Session Hub 接口文档

这份文档只讲 **现在代码里已经实现的 Session Hub 接口**。

如果你只想先看仓库里现成的接口说明，先看这份文档本身。

当前仓库还没有机器可读的 OpenAPI 文件。

如果后续补上，建议放在：

- `docs/api/funclaw-hub.openapi.yaml`

如果你要核对“文档是不是和代码一致”，以这几个文件为准：

- `src/funclaw/hub/server.ts`
- `src/funclaw/hub/store.ts`
- `src/funclaw/contracts/constants.ts`
- `src/funclaw/contracts/schema.ts`

---

## 1. 一句话说明它是干嘛的

Session Hub 是 FunClaw 和 OpenClaw Worker 之间的中转层。

它主要做 4 件事：

1. 维护 `session_id -> worker_id` 的粘性绑定
2. 接收 HTTP 请求，把任务派给绑定的 Worker
3. 通过 WebSocket 和 Worker / Adapter 长连通信
4. 记录 request、artifact、session 的状态

---

## 2. 默认配置

配置定义在 `src/funclaw/contracts/constants.ts`。

| 项目 | 默认值 |
| --- | --- |
| 协议版本 | `1` |
| 监听 host | `0.0.0.0` |
| 监听端口 | `31880` |
| WS 连接握手超时 | `10000ms` |
| HTTP 请求默认超时 | `30000ms` |
| HTTP Body 上限 | `5000000` 字节 |
| artifact 内联阈值 | `1048576` 字节（1MB） |
| Worker 心跳间隔 | `15000ms` |

默认数据目录路径来自 `src/funclaw/hub/paths.ts`：

- `~/.openclaw/funclaw-hub/sessions.json`
- `~/.openclaw/funclaw-hub/requests.jsonl`
- `~/.openclaw/funclaw-hub/artifacts.json`
- `~/.openclaw/funclaw-hub/artifacts/`

---

## 3. 核心对象

### 3.1 Session

表示一条业务会话绑定到了哪台 Worker。

关键字段：

- `session_id`：FunClaw 侧会话 ID
- `worker_id`：当前绑定的 Worker
- `adapter_id`：发起方标识
- `openclaw_session_key`：Worker 调 OpenClaw 时使用的 session key
- `status`：`bound` 或 `worker_offline`
- `last_request_id`：最近一次请求 ID

### 3.2 Request

表示 Hub 收到的一次任务。

当前状态流转是：

```text
queued -> running -> completed / failed
```

代码里还预留了 `canceled`，但当前服务端没有主动发 `task.cancel` 的实现。

补充两个容易误解的点：

- `outputs`：协议上支持中间输出；但当前现网 Go worker 对 `responses.create` 默认**不使用** `task.output`，所以这类请求通常会是空数组
- `result`：只有 request 进入终态后才会出现；结构会随 `action` 变化

当前 `responses.create` 在终态下，`result` 已经稳定包含下面这些字段：

```json
{
  "payloads": [
    {
      "text": "最终回复文本"
    }
  ],
  "meta": {
    "usage": {
      "input": 1182,
      "output": 915,
      "cacheRead": 42808,
      "cacheWrite": 0,
      "totalTokens": 44905
    }
  },
  "tool_calls": [
    {
      "seq": 4,
      "id": "call_abc",
      "name": "read",
      "arguments": {
        "path": "~/.openclaw/workspace/skills/byted-web-search/SKILL.md"
      }
    }
  ],
  "tool_results_summary": [
    {
      "seq": 5,
      "tool_call_id": "call_abc",
      "name": "read",
      "summary": "工具结果摘要文本",
      "is_error": false
    }
  ]
}
```

字段说明：

- `payloads`：当前最终回复文本列表；FunClaw 至少要读取这里的 `text`
- `meta.usage`：OpenClaw 回传的 usage 信息，字段可能随上游 provider 略有变化
- `tool_calls`：这次 run 在 session history 里记录到的工具调用摘要
- `tool_results_summary`：和 `tool_calls` 对应的工具结果摘要

注意：

- 如果这次 run 根本没走工具，`tool_calls` 和 `tool_results_summary` 会是空数组
- 空数组表示“本次没有工具调用”，**不是** Hub 丢字段
- 当前这些工具过程字段是跟随最终 `task.completed -> request.result` 一起返回，不是边跑边推

### 3.3 Artifact

表示 Worker 产出的附件。

当前 transport 只真正落这两种：

- `inline`：内容直接写进 `inline_base64`
- `hub_file`：内容落盘，返回 `download_url`

协议里还保留了 `object_store`，但现在没有实现；如果真返回这个值，`GET /api/v1/artifacts/{artifactId}/content` 会给 `501`。

---

## 4. 鉴权规则

### 4.1 HTTP

定义见 `src/funclaw/hub/server.ts`。

- `GET /healthz`
- `GET /health`
- `GET /readyz`
- `GET /ready`
- `GET /ws`

上面这些路径 **不走 Bearer Token 校验**。

其余 `/api/v1/**` HTTP 接口：

- 如果 Hub 没配置 token：不校验
- 如果 Hub 配了 token：必须带

```http
Authorization: Bearer <FUNCLAW_HUB_TOKEN>
```

### 4.2 WebSocket

WebSocket 连接建立后，客户端在 `connect` 请求里传：

```json
{
  "auth": {
    "token": "<FUNCLAW_HUB_TOKEN>"
  }
}
```

如果 Hub 没配置 token，这个字段可以不传。

---

## 5. HTTP 接口总览

### 5.1 健康检查

#### `GET /healthz`
#### `GET /health`

用途：只看进程活没活。

返回：`200`

```json
{
  "ok": true,
  "status": "live"
}
```

补充：`HEAD` 也支持。

#### `GET /readyz`
#### `GET /ready`

用途：看当前有没有可用 Worker。

- 有至少 1 台 Worker 在线：`200`
- 一台都没有：`503`

返回示例：

```json
{
  "ok": true,
  "status": "ready",
  "workers_online": 1
}
```

补充：`HEAD` 也支持。

---

### 5.2 WebSocket 升级入口

#### `GET /ws`

这个路径本身是给 WebSocket Upgrade 用的。

如果你直接用普通 HTTP GET 调它，会返回：

- 状态码：`426`
- 正文：`Upgrade Required`

---

### 5.3 查询在线 Worker

#### `GET /api/v1/workers`

用途：看现在有哪些 Worker 在线。

返回：`200`

```json
{
  "ok": true,
  "workers": [
    {
      "workerId": "openclaw-main-1",
      "hostname": "arkclaw",
      "version": "1.0.0",
      "capabilities": ["responses.create", "session.history.get", "node.invoke"],
      "connectedAt": "2026-04-15T08:00:00.000Z",
      "lastHeartbeatAt": "2026-04-15T08:00:10.000Z"
    }
  ]
}
```

---

### 5.4 创建或声明 Session

#### `POST /api/v1/sessions`

用途：

- 第一次进来的 `session_id`：挑一台在线 Worker 绑定
- 已经存在的 `session_id`：直接返回现有绑定

请求体：

```json
{
  "session_id": "conversation-123",
  "adapter_id": "funclaw-sidecar-a",
  "openclaw_session_key": "funclaw:conversation-123"
}
```

字段说明：

- `session_id`：必填
- `adapter_id`：可选，不传时会落成 `http-adapter`
- `openclaw_session_key`：可选，不传时会落成 `funclaw:<session_id>`

返回：`200`

```json
{
  "ok": true,
  "session": {
    "session_id": "conversation-123",
    "worker_id": "openclaw-main-1",
    "adapter_id": "funclaw-sidecar-a",
    "openclaw_session_key": "funclaw:conversation-123",
    "status": "bound",
    "created_at": "2026-04-15T08:00:00.000Z",
    "last_seen_at": "2026-04-15T08:00:00.000Z"
  }
}
```

失败情况：

- `400`：请求体不合法
- `503`：当前没有在线 Worker

补充：当前 Worker 选择逻辑很简单，就是取按 `workerId` 排序后的第一台在线 Worker，代码在 `src/funclaw/hub/store.ts`。

---

### 5.5 往 Session 提交任务

#### `POST /api/v1/sessions/{sessionId}/messages`

用途：给一个 session 派发任务。

这一步会自动做两件事：

1. 先确保 session 已经存在
2. 再创建 request，并立刻把 `task.assigned` 发给绑定 Worker

请求体：

```json
{
  "request_id": "optional-idempotency-key",
  "adapter_id": "funclaw-sidecar-a",
  "openclaw_session_key": "funclaw:conversation-123",
  "action": "responses.create",
  "input": {
    "model": "openclaw",
    "input": "你好"
  }
}
```

当前 `action` 只支持 3 个值：

- `responses.create`
- `session.history.get`
- `node.invoke`

返回：`202`

```json
{
  "ok": true,
  "request": {
    "request_id": "req_123",
    "session_id": "conversation-123",
    "worker_id": "openclaw-main-1",
    "adapter_id": "funclaw-sidecar-a",
    "openclaw_session_key": "funclaw:conversation-123",
    "action": "responses.create",
    "input": {
      "model": "openclaw",
      "input": "你好"
    },
    "status": "queued",
    "created_at": "2026-04-15T08:00:00.000Z",
    "updated_at": "2026-04-15T08:00:00.000Z",
    "outputs": [],
    "artifacts": []
  }
}
```

失败情况：

- `400`：请求体不合法
- `503`：Worker 不在线，或者 Hub 当前不能接这个请求

---

### 5.6 查 request 当前状态

#### `GET /api/v1/requests/{requestId}`

用途：轮询 request。

返回：`200`

```json
{
  "ok": true,
  "request": {
    "request_id": "req_123",
    "session_id": "conversation-123",
    "worker_id": "openclaw-main-1",
    "adapter_id": "funclaw-sidecar-a",
    "openclaw_session_key": "funclaw:conversation-123",
    "action": "responses.create",
    "input": {
      "stream": false,
      "input": "请在抖音上帮我获取关于电影战狼相关的播放量最高的top5的短视频的播放地址"
    },
    "status": "completed",
    "created_at": "2026-04-20T08:16:03.731Z",
    "updated_at": "2026-04-20T08:16:58.585Z",
    "accepted_at": "2026-04-20T08:16:03.741Z",
    "finished_at": "2026-04-20T08:16:58.585Z",
    "outputs": [],
    "result": {
      "payloads": [
        {
          "text": "为你找到抖音上战狼相关播放量最高的Top5短视频链接：..."
        }
      ],
      "meta": {
        "usage": {
          "input": 6645,
          "output": 814,
          "cacheRead": 53048,
          "cacheWrite": 0,
          "totalTokens": 60507
        }
      },
      "tool_calls": [
        {
          "seq": 4,
          "id": "call_56nizzlzhkqhb38e4f43wse1",
          "name": "read",
          "arguments": {
            "path": "~/.openclaw/workspace/skills/byted-web-search/SKILL.md"
          }
        },
        {
          "seq": 6,
          "id": "call_wa9iwyb3k3pkh0r5odqhk6sz",
          "name": "exec",
          "arguments": {
            "command": "cd ~/.openclaw/workspace/skills/byted-web-search && python3 scripts/web_search.py \"抖音 战狼电影 播放量最高 top5 短视频链接\" --count 10 --query-rewrite"
          }
        }
      ],
      "tool_results_summary": [
        {
          "seq": 5,
          "tool_call_id": "call_56nizzlzhkqhb38e4f43wse1",
          "name": "read",
          "summary": "工具结果摘要文本",
          "is_error": false
        }
      ]
    },
    "artifacts": []
  }
}
```

失败情况：

- `404`：request 不存在

---

### 5.7 等待 request 结束

#### `POST /api/v1/requests/{requestId}/await`

用途：阻塞等 request 进入终态。

请求体：

```json
{
  "timeout_ms": 30000
}
```

返回分两种：

#### 1）已经结束：`200`

`request.status` 会是：

- `completed`
- `failed`
- `canceled`

一个 `responses.create` 已完成的返回示例：

```json
{
  "ok": true,
  "request": {
    "request_id": "req_123",
    "status": "completed",
    "outputs": [],
    "result": {
      "payloads": [
        {
          "text": "该文件的第一行是：`---`"
        }
      ],
      "meta": {
        "usage": {
          "input": 3019,
          "output": 1878,
          "cacheRead": 42808,
          "cacheWrite": 0,
          "totalTokens": 47705
        }
      },
      "tool_calls": [
        {
          "seq": 2,
          "id": "call_dzbr9t3w3nzh8jw5ebt0x0om",
          "name": "read",
          "arguments": {
            "path": "~/.openclaw/workspace/skills/browser-use/SKILL.md"
          }
        }
      ],
      "tool_results_summary": [
        {
          "seq": 3,
          "tool_call_id": "call_dzbr9t3w3nzh8jw5ebt0x0om",
          "name": "read",
          "summary": "--- name: browser description: \"Browser automation...\"",
          "is_error": false
        }
      ]
    },
    "artifacts": []
  }
}
```

#### 2）超时还没结束：`202`

这时不会报错，而是直接把当前 request 快照返回回来。

失败情况：

- `400`：请求体不合法
- `404`：request 不存在

---

### 5.8 取 session 历史

#### `GET /api/v1/sessions/{sessionId}/history`

用途：让 Hub 代发一个 `session.history.get` 任务，并同步等待结果。

这个接口和 `POST /api/v1/sessions/{sessionId}/messages` 有个区别：

- `messages`：如果 session 不存在，会自动 `ensureSession`
- `history`：如果 session 不存在，直接 `404`

查询参数会原样透传给 Worker。

常见参数：

- `limit`
- `cursor`

成功返回：`200`

```json
{
  "ok": true,
  "request_id": "req_123",
  "result": {
    "items": []
  }
}
```

失败情况：

- `404`：session 不存在
- `502`：Worker / OpenClaw 历史查询失败
- `503`：Hub 无法派发
- `504`：等待超时

补充：这个接口内部等待时间固定走 `30000ms` 默认值，不读客户端自定义超时。

---

### 5.9 查 artifact 元数据

#### `GET /api/v1/artifacts/{artifactId}`

用途：拿附件描述信息。

成功返回：`200`

```json
{
  "ok": true,
  "artifact": {
    "artifact_id": "art_123",
    "kind": "image",
    "filename": "demo.png",
    "mime_type": "image/png",
    "size_bytes": 12345,
    "sha256": "...",
    "transport": "inline"
  }
}
```

失败情况：

- `404`：artifact 不存在

---

### 5.10 下载 artifact 内容

#### `GET /api/v1/artifacts/{artifactId}/content`

用途：直接拿二进制正文。

行为：

- `inline`：Hub 直接把 `inline_base64` 解码后返回
- `hub_file`：Hub 从本地文件读取后返回
- `object_store`：当前未实现，返回 `501`

成功返回：`200`

响应头里会带：

- `Content-Type: <artifact.mime_type>`
- `Content-Disposition: inline; filename="<artifact.filename>"`

失败情况：

- `404`：artifact 不存在，或者正文丢了
- `501`：当前 transport 还没实现

---

## 6. WebSocket 协议

HTTP 主要给调用方用。

Worker / Adapter 和 Hub 的实时协作用的是 `GET /ws` 这条 WebSocket 长连。

### 6.1 顶层帧格式

#### 请求帧

```json
{
  "type": "req",
  "id": "req-1",
  "method": "connect",
  "params": {}
}
```

#### 响应帧

```json
{
  "type": "res",
  "id": "req-1",
  "ok": true,
  "payload": {}
}
```

#### 事件帧

```json
{
  "type": "event",
  "event": "task.assigned",
  "payload": {},
  "seq": 12
}
```

---

### 6.2 握手流程

连接建立后，Hub 会先发：

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "7b27c9...",
    "ts": 1776240000000
  },
  "seq": 1
}
```

客户端第一条请求必须是 `connect`，并且要把这个 `nonce` 原样带回去。

#### Worker 握手示例

```json
{
  "type": "req",
  "id": "connect-1",
  "method": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,
    "role": "worker",
    "nonce": "7b27c9...",
    "auth": {
      "token": "<FUNCLAW_HUB_TOKEN>"
    },
    "client": {
      "id": "funclaw-worker",
      "version": "1.0.0",
      "platform": "linux",
      "mode": "worker"
    },
    "worker": {
      "worker_id": "openclaw-main-1",
      "hostname": "arkclaw",
      "version": "1.0.0",
      "capabilities": ["responses.create", "session.history.get", "node.invoke"]
    }
  }
}
```

#### Adapter 握手示例

```json
{
  "type": "req",
  "id": "connect-1",
  "method": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,
    "role": "adapter",
    "nonce": "7b27c9...",
    "client": {
      "id": "funclaw-adapter",
      "version": "1.0.0",
      "platform": "linux",
      "mode": "adapter"
    },
    "adapter": {
      "adapter_id": "funclaw-sidecar-a",
      "version": "1.0.0"
    }
  }
}
```

Hub 成功响应后，会返回 `hello-ok`，里面带：

- `protocol`
- `server.connId`
- `policy.heartbeatIntervalMs`
- `policy.maxInlineArtifactBytes`
- `features.methods`
- `features.events`

---

### 6.3 Hub -> Worker 事件

当前真正会发的关键事件：

#### `connect.challenge`

握手挑战。

#### `task.assigned`

Hub 给 Worker 派任务。

载荷字段：

- `request_id`
- `session_id`
- `worker_id`
- `adapter_id`
- `openclaw_session_key`
- `action`
- `input`
- `created_at`

协议里还宣告了 `task.cancel`，但当前服务端没有实际下发逻辑。

---

### 6.4 Worker -> Hub 方法

当前 Hub 支持这些方法：

#### `worker.heartbeat`

更新 Worker 在线心跳。

#### `task.accepted`

把 request 状态从 `queued` 改成 `running`。

#### `task.output`

追加一条中间输出到 `request.outputs`。

补充：

- 这是协议能力，Hub 已经支持
- 但当前现网 Go worker 对 `responses.create` 默认不发 `task.output`
- 所以想拿工具过程时，当前应该优先读取最终 `request.result.tool_calls` 和 `request.result.tool_results_summary`

#### `artifact.register`

上传一个 artifact 给 Hub，Hub 会返回 `ArtifactDescriptor`。

#### `task.completed`

把 request 标成 `completed`，并写入：

- `result`
- `artifacts`
- `finished_at`

#### `task.failed`

把 request 标成 `failed`，并写入：

- `error`
- `finished_at`

---

### 6.5 Adapter 可收到的事件

当 Adapter 通过 WS 连进来后，Hub 会往对应 `adapter_id` 的连接推这些事件：

- `request.updated`
- `artifact.ready`
- `request.completed`

这些推送逻辑在 `src/funclaw/hub/server.ts` 里。

---

## 7. 一条完整调用链

最常见的闭环是这样：

```text
1. Adapter 调 POST /api/v1/sessions
2. Adapter 调 POST /api/v1/sessions/{sessionId}/messages
3. Hub 给 Worker 发 task.assigned
4. Worker 回 task.accepted
5. Worker 按需回 task.output / artifact.register
6. Worker 回 task.completed 或 task.failed
7. Adapter 轮询 GET /api/v1/requests/{requestId}
   或者阻塞调 POST /api/v1/requests/{requestId}/await
```

当前现网对 `responses.create` 再补一句：

- 最终文本、usage、工具调用摘要、工具结果摘要，都是跟着 `task.completed -> request.result` 一起回来
- 不要假设工具过程一定会出现在 `request.outputs`

---

## 8. 现在这份文档和 OpenAPI 怎么配合

建议这么看：

- 人看流程和语义：`docs/api/session-hub-接口文档.md`
- 机器对接 HTTP：当前仓库未包含 OpenAPI 文件；后续建议补到 `docs/api/funclaw-hub.openapi.yaml`
- 核对协议字段：`src/funclaw/contracts/schema.ts`
- 核对运行时行为：`src/funclaw/hub/server.ts`

如果后面代码改了，优先先改：

1. `src/funclaw/contracts/schema.ts`
2. `src/funclaw/hub/server.ts`
3. 如果后续补了 OpenAPI，再改 `docs/api/funclaw-hub.openapi.yaml`
4. 这份文档

这样不容易文档漂移。
