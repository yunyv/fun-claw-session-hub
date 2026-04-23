---
name: funclaw-worker-rollout
description: 当用户要求替换、上线、回滚、重启或排查生产 FunClaw worker（`go-worker-codex`）时使用。用于 Codex 自己执行标准发布流程：本地验证、构建 Linux amd64 静态二进制、上传到 OpenClaw 机器、备份旧版、切换 live 二进制、重启 `openclaw-main-1`、校验只剩一个进程、必要时回滚。
---

# FunClaw Worker Rollout

这个 skill 是给 Codex 自己用的，不是给 OpenClaw runtime 用的。

只用于这条生产链路：

- live 二进制：`/home/yunyv/apps/funclaw-worker-run/go-worker-codex`
- worker id：`openclaw-main-1`
- PID 文件：`/home/yunyv/funclaw-worker.pid`
- 日志：`/home/yunyv/openclaw-main-1.log`
- Hub WS：`ws://127.0.0.1:31880/ws`
- Gateway HTTP：`http://127.0.0.1:18790`
- Gateway WS：`ws://127.0.0.1:18790`

不要把这个流程用于 Hub 发布。

## 先读这些文件

- `Funclaw/ssh相关的事情.md`
- `Funclaw/给Codex-OpenClaw-root和OSS排坑简述.md`
- `Funclaw/session-hub-接口文档.md`
- `README.md`
- `src/funclaw/worker/README.md`
- `src/funclaw/worker/cmd/go-worker/main.go`
- `src/funclaw/worker/internal/hubclient/hubclient.go`
- `src/funclaw/worker/internal/gatewayclient/gatewayclient.go`
- `src/funclaw/hub/server.ts`
- `src/funclaw/hub/store.ts`

## 先记住现网机器和文件位置

### 1. 中转机

- Host alias：`aliyun-relay`
- IP：`47.118.27.59`
- 用户：`relay`
- Hub HTTP：`http://47.118.27.59:31880`
- Hub WS：`ws://47.118.27.59:31880/ws`
- Hub runner：`/home/relay/apps/funclaw-session-hub/funclaw-hub-runner.mjs`
- Hub 启动日志：`/home/relay/funclaw-hub.log`
- Hub PID：`/home/relay/funclaw-hub.pid`
- Hub 状态文件目录：`/home/relay/.openclaw/funclaw-hub`
- 最重要的状态文件：
  - `requests.jsonl`
  - `sessions.json`
  - `artifacts.json`

### 2. OpenClaw 机器

- 通过中转机上的 `127.0.0.1:22222` 登录
- worker 进程用户：`yunyv`
- worker live 二进制：`/home/yunyv/apps/funclaw-worker-run/go-worker-codex`
- worker 日志：`/home/yunyv/openclaw-main-1.log`
- worker PID 文件：`/home/yunyv/funclaw-worker.pid`
- worker 看 Hub：`ws://127.0.0.1:31880/ws`
- worker 看 Gateway：`http://127.0.0.1:18790`

### 3. FunClaw 服务器

- 通过中转机上的 `127.0.0.1:60022` 登录
- 业务日志目录：`/data/logs/`
- 最常看的日志：
  - `/data/logs/fun-claw-api/fun-claw-api-staging.log`
  - `/data/logs/fun-claw-agent/fun-claw-agent-staging.log`

### 4. root 和 yunyv 各管什么

- worker 二进制、worker 进程、worker 日志在 `yunyv` 这套下面
- FunClaw 这条链路真正执行工具时，用的是 OpenClaw 机器上的 `root` 环境
- 这意味着：
  - worker 启停与日志，先看 `yunyv`
  - skills、workspace、gateway 配置、OSS、浏览器类问题，先看 `root`
- FunClaw 这条链路的 root 关键位置：
  - workspace：`/root/.openclaw/workspace`
  - 个人 skills：`/root/.agents/skills`
  - gateway 配置：`/root/.openclaw/funclaw-gateway.json`

## 硬规则

1. 先做本地验证，再碰线上。
2. 一律先构建 Linux `amd64` 二进制。
3. 优先构建静态版：

```bash
cd src/funclaw/worker
CGO_ENABLED=0 go build -o ../../.tmp/go-worker-codex-rollout ./cmd/go-worker
```

4. 先上传到 stage 文件，不要直接覆盖 live。
5. 切换前必须备份 live 二进制。
6. 切换后只能保留一个 `openclaw-main-1` 进程。
7. 如果新版本起不来，立刻回滚，不要拖。
8. FunClaw 生产链路的 Gateway 是 `18790`，不是 `18789`。
9. 看到聊天页报 `SUBMITTED`，先不要急着重启 worker；先查 `requests.jsonl`。
10. 中转机上的 `funclaw-hub.log` 只有启动信息时，不代表 Hub 没工作；先看状态文件。

## 排查顺序

### 1. 先分清问题在哪一层

- 聊天页报错、会话状态异常：先看 FunClaw 服务器日志
- 请求有没有进 Hub、停在哪个状态：看中转机上的 `requests.jsonl`
- worker 有没有收到任务、有没有回 `task.accepted`：看 OpenClaw 机器上的 worker 日志
- 工具执行、OSS、浏览器、skills 选错：看 OpenClaw 机器上的 root 环境

### 2. 先看 FunClaw 服务器日志

重点搜这些词：

- `chat-registered-agent`
- `providerStatus=queued`
- `hubStatus=queued`
- `AsyncRequestTimeoutException`
- `session-hub`

经验：

- 如果看见 `status=SUBMITTED providerStatus=queued`
- 或者看见 `hubStatus=queued`

这通常不是最终回复，而是上游还没完成时拿到的一份当前快照。

### 3. 再看 Hub 状态文件，不要只看 Hub 启动日志

先看：

```bash
ssh aliyun-relay
ls -lah /home/relay/.openclaw/funclaw-hub
tail -n 50 /home/relay/.openclaw/funclaw-hub/requests.jsonl
tail -n 80 /home/relay/.openclaw/funclaw-hub/sessions.json
curl http://127.0.0.1:31880/health
curl http://127.0.0.1:31880/ready
```

判断方法：

- 正常请求会出现 `queued -> running -> completed`，同一个 `request_id` 至少会写多行
- 如果一个 `request_id` 只有 `queued`，说明 Hub 已建单，但 worker 没回 `task.accepted`
- `ready` 里如果是 `workers_online=1`，只能说明 Hub 认为有 worker 在线，不能说明 worker 一定在干活
- `sessions.json` 里 `status=bound` 也只能说明 session 还绑在那台 worker 上

### 4. 最后看 worker 自己有没有处理任务

worker 代码顺序是：

1. 收到 `task.assigned`
2. 先发 `task.accepted`
3. 再调 Gateway
4. 最后发 `task.completed` 或 `task.failed`

所以看日志时，先找下面这些词：

- `Received task`
- `Processing task`
- `Sending task.accepted`
- `CallAgent accepted`
- `waitForAgentCompletion status`
- `Sending task.completed`
- `Sending task.failed`

如果 `requests.jsonl` 里只有 `queued`，而 worker 日志里连 `Sending task.accepted` 都没有，优先判断为：

- worker 没收到任务
- worker 收到后卡死
- worker WebSocket 看起来还在线，但实际上没有继续处理

### 5. root 环境什么时候看

出现下面这些现象时，再切到 root：

- 回复里有 `/root/.openclaw/workspace/...`
- 工具调用摘要里出现 `read ~/.openclaw/workspace/...`
- OSS 上传、浏览器、skills 选择异常
- 你怀疑不是 worker 本身，而是 gateway 执行期的问题

常看内容：

```bash
ssh aliyun-relay -t "sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1"
echo 'KbxqGxQWax8vKzqB' | sudo -S bash -lc 'sed -n "1,240p" /root/.openclaw/funclaw-gateway.json'
echo 'KbxqGxQWax8vKzqB' | sudo -S bash -lc 'find /root/.agents -maxdepth 3 -type d | sort'
echo 'KbxqGxQWax8vKzqB' | sudo -S bash -lc 'find /root/.openclaw/workspace/skills -maxdepth 2 -type f | sort | head -n 200'
```

## SSH 和转发的易错点

### 1. 端口含义

- `127.0.0.1:22222`：中转机到 OpenClaw `22`
- `127.0.0.1:60022`：中转机到 FunClaw `22`
- `127.0.0.1:28789`：中转机到 OpenClaw `127.0.0.1:18789`
- `127.0.0.1:31880`：OpenClaw 机器本机访问 Hub
- `127.0.0.1:18790`：FunClaw 专用 Gateway
- `127.0.0.1:18789`：旧的或通用 Gateway，不是这条链路的主入口

### 2. SSH 先用短命令，再用长命令

先跑这种短命令：

```bash
ssh aliyun-relay
sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1 'echo ok; whoami; hostname'
```

短命令能通，再去跑 `tail`、`find`、`python3 - <<'PY'` 这种长命令。

### 3. 双跳里看到卡住，不要马上怀疑 worker

按这个顺序查：

1. 先确认中转机登录正常
2. 再确认 `127.0.0.1:22222` 端口是否通
3. 再确认 SSH 认证是否真的过了

端口检查示例：

```bash
ssh aliyun-relay
timeout 5 bash -lc 'cat < /dev/null > /dev/tcp/127.0.0.1/22222' && echo PORT22222_OK || echo PORT22222_FAIL
```

补认证细节时，用：

```bash
ssh aliyun-relay
timeout 10 sshpass -v -p 'KbxqGxQWax8vKzqB' ssh -vv -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no -p 22222 yunyv@127.0.0.1 'echo ok'
```

经验：

- 端口通，只能说明反向转发还在
- 认证卡住，说明 SSH 会话本身还有问题
- `ssh -t "..."` 里塞太长的命令，容易被引号、换行、here-doc 搞乱
- 交互排查时，优先先开一层中转机会话，再逐条敲命令

### 4. `18790` 和 `18789` 的区分不能混

- worker 配置、FunClaw 线上排查、gateway 配置，一律先看 `18790`
- 看到 `18789` 时，先确认这是不是老链路或排障链路
- 不要把 FunClaw 的异常先改到 `18789`

## 标准流程

### 1. 本地验证

至少跑和 worker 直接相关的检查：

```bash
bun run test:ts -- src/funclaw/worker/run.test.ts
cd src/funclaw/worker && go test ./...
```

如果改动范围更大，再补更大的验证。

### 2. 本地构建

```bash
cd src/funclaw/worker
CGO_ENABLED=0 go build -o ../../.tmp/go-worker-codex-rollout ./cmd/go-worker
file ../../.tmp/go-worker-codex-rollout
sha256sum ../../.tmp/go-worker-codex-rollout
```

如果不是 Linux `amd64`，停下重来。

### 3. 上线前看线上现状

先确认：

- live 二进制存在
- 当前 SHA 能读到
- 当前 worker 进程在跑
- 当前日志可读

常用命令：

```bash
ssh aliyun-relay -t "sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1 'file /home/yunyv/apps/funclaw-worker-run/go-worker-codex; sha256sum /home/yunyv/apps/funclaw-worker-run/go-worker-codex; pgrep -af /home/yunyv/apps/funclaw-worker-run/go-worker-codex; tail -n 30 /home/yunyv/openclaw-main-1.log'"
```

如果这次是排障，不是发版，再补这些：

```bash
ssh aliyun-relay -t "sshpass -p 'Ss123456!' ssh -o StrictHostKeyChecking=no -p 60022 root@127.0.0.1 'tail -n 120 /data/logs/fun-claw-api/fun-claw-api-staging.log'"
ssh aliyun-relay -t "tail -n 50 /home/relay/.openclaw/funclaw-hub/requests.jsonl"
ssh aliyun-relay -t "tail -n 80 /home/relay/.openclaw/funclaw-hub/sessions.json"
ssh aliyun-relay -t "curl -s http://127.0.0.1:31880/health && echo && curl -s http://127.0.0.1:31880/ready"
```

### 4. 上传到 stage

推荐 stage 路径：

- `/home/yunyv/apps/funclaw-worker-run/go-worker-codex.stage`
- `/home/yunyv/apps/funclaw-worker-run/go-worker-codex.stage-<change>`

示例：

```bash
target=/home/yunyv/apps/funclaw-worker-run/go-worker-codex.stage
ssh aliyun-relay "sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1 'cat > ${target}'" < .tmp/go-worker-codex-rollout
ssh aliyun-relay -t "sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1 'chmod 755 ${target}; file ${target}; sha256sum ${target}'"
```

远端 stage SHA 必须和本地一致。

### 5. 切换 live 二进制

原则：

- 用当前进程的启动参数做真相来源
- 不要手敲一套新的启动命令
- 先备份，再切换，再重启

安全切换模板：

```bash
ssh aliyun-relay "sshpass -p 'KbxqGxQWax8vKzqB' ssh -o StrictHostKeyChecking=no -p 22222 yunyv@127.0.0.1 'bash -s'" <<'EOF'
set -euo pipefail
bin_dir=/home/yunyv/apps/funclaw-worker-run
live_bin="$bin_dir/go-worker-codex"
stage_bin="$bin_dir/go-worker-codex.stage"
log_file=/home/yunyv/openclaw-main-1.log
pid_file=/home/yunyv/funclaw-worker.pid
ts=$(date +%Y%m%d-%H%M%S)
pid=$(pgrep -fo '/home/yunyv/apps/funclaw-worker-run/go-worker-codex --worker-id=openclaw-main-1' || true)
test -n "$pid"
cmd=$(ps -o args= -p "$pid")
test -n "$cmd"
cp -p "$live_bin" "$bin_dir/go-worker-codex.bak-$ts"
mv "$stage_bin" "$live_bin"
chmod 755 "$live_bin"
kill "$pid"
for _ in $(seq 1 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  kill -9 "$pid"
fi
nohup bash -lc "exec $cmd" >> "$log_file" 2>&1 &
new_pid=$!
echo "$new_pid" > "$pid_file"
sleep 2
ps -p "$new_pid" -o pid=,args=
EOF
```

### 6. 切换后校验

至少确认这几件事：

1. `pgrep -af /home/yunyv/apps/funclaw-worker-run/go-worker-codex` 只剩一个真实 worker。
2. `/home/yunyv/funclaw-worker.pid` 和真实 PID 一致。
3. `tail -n 50 /home/yunyv/openclaw-main-1.log` 里能看到新启动和成功连 Hub。
4. 如果这次改动里有明显特征文本，可以用 `strings | grep` 确认 live 二进制确实是新版本。
5. 如果这次改动涉及行为，补一条真实业务验证。

## 回滚流程

出现下面这些情况就回滚：

- 新进程起不来
- 新进程反复退出
- 日志显示 Hub 或 Gateway 地址不对
- 上传错二进制
- 真实功能已经明显异常

回滚步骤：

1. 找最新的 `go-worker-codex.bak-*`
2. 把它移回 `go-worker-codex`
3. 用同样的方式重启
4. 再做一次单进程和日志校验

## 常见情况处理

### 1. 远端 stage SHA 和本地不一致

视为上传失败。

- 不要切 live
- 重新上传
- 必要时删掉坏的 stage 文件

### 2. stage 二进制架构不对

直接重编。

- 目标必须是 Linux `amd64`
- 如果误编成动态版，补 `CGO_ENABLED=0`

### 3. 重启后起了两个同名 worker

这不是小问题，必须收敛。

- 以 PID 文件里的进程为准
- 杀掉多余的 `go-worker-codex`
- 再次 `pgrep -af` 确认只剩一个

### 4. 进程起来了，但没正常连上

先看最新日志。

重点排查：

- Hub token
- Gateway token
- Hub WS 地址
- Gateway 端口是不是误用了 `18789`
- 中转机上的 `31880` 是否健康
- `requests.jsonl` 里新请求有没有从 `queued` 变成 `running`
- OpenClaw 机器上的 SSH 会话是不是本身就卡住

### 5. 不能确定 live 的是不是新二进制

至少用一种硬证据：

- `sha256sum`
- `file`
- `strings | grep` 唯一文本
- 新启动时间和日志时间对上

### 6. 旧 PID 杀不掉

先等一小会，再 `kill -9`。  
确认旧 PID 真没了，再起新进程。

### 7. 页面报 `SUBMITTED`

先查这三处，不要先改代码：

1. FunClaw API 日志里是不是有 `providerStatus=queued` 或 `hubStatus=queued`
2. `requests.jsonl` 里这个 `request_id` 是不是只有 `queued`
3. worker 日志里有没有 `Sending task.accepted`

如果同时满足下面三条：

- Hub `ready` 仍显示 `workers_online=1`
- `requests.jsonl` 里请求停在 `queued`
- worker 日志里没有对应的 `task.accepted`

优先判断为：Hub 认为 worker 在线，但这台 worker 没真正处理任务。

### 8. 中转机上的 Hub 日志几乎没有业务内容

`/home/relay/funclaw-hub.log` 现在主要只有启动信息。

所以：

- 不要因为这个文件很干净，就误判 Hub 没接到请求
- 要以 `requests.jsonl`、`sessions.json`、`/health`、`/ready` 为准

### 9. OSS 或 skills 行为异常

优先确认这些：

- 真正执行的是 root 环境，不是 `yunyv`
- `/root/.openclaw/funclaw-gateway.json` 里有没有 FunClaw 用的 skill 环境变量
- `/root/.agents/skills` 里有没有不该回来的旧 skill
- 工具调用摘要里读到的是不是 `/root/.openclaw/workspace/skills/...`

## 最后汇报格式

结束后至少汇报：

1. 改了什么
2. 本地验证跑了哪些
3. live 二进制 SHA
4. 备份文件路径
5. live PID
6. 是否只剩一个 worker
7. 是否做了真实线上验证

如果没做真实线上验证，要明确说没做。
