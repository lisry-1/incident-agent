# 独立诊断容器、人工审批与受控重启

本轮新增一条独立流程：隔离诊断 → 证据绑定 Proposal → 人工签名 → 一次性执行 → 实测验证。首个执行动作是本地实验 Pod checkout-k8s 中 checkout 容器的一次重启。本页记录重启流程；新增 Deployment 配置回滚见 [回滚验收](ROLLBACK.md)，不把重启称为发布回滚或生产自动修复。

## 信任与权限分离

| 组件 | 允许的能力 | 不持有的能力 |
| --- | --- | --- |
| 独立诊断容器 | 经 Unix socket 查询四源证据、生成一份待审批提案；可选 Pi 模型循环 | 审批密钥、Kubernetes 凭据、Docker socket、任意网络出口 |
| 可信诊断 Broker | 固定范围读取 Prometheus/Loki/Jaeger/Kubernetes，复用阶段、预算、熔断和审计 | 没有审批或执行 HTTP 路由 |
| 人工审批 CLI | 展示已签名提案，交互确认后签发绑定摘要的审批 | 不接受模型字段 approved=true 或管道输入作为人工批准 |
| 受控执行器 | 验证两次签名、目标与有效期后，对唯一实验容器执行固定重启代码并验证结果 | 没有任意 shell、任意参数或任意命名空间的执行入口 |

容器使用非 root UID 65532、只读根文件系统、cap-drop ALL、no-new-privileges、network none、64 个进程和 256 MiB 内存上限。仅挂载只读 Unix socket 和无密钥的 scope 配置文件。启动时探测 IP 出口、根目录写入、凭据/Docker socket 可见性与审批/写工具路由；操作者随后检查实际 Docker inspect 配置。检测失败就停止，不降低隔离继续运行。

Broker 位于可信宿主机，持有此前的只读 reader 凭据。模型、工具和不可信日志都不能让它转发任意 URL、HTTP 方法或 Kubernetes 路径。可选模型请求只转发到固定 DeepSeek Anthropic endpoint，最多 8 次、每次最多 4096 输出 token，密钥保留在 Broker；正文最多 256 KiB，响应最多 2 MiB。模型上下文仅展示最多 8 条样本时会附 context_sample，完整证据仍保留在 Broker 审计中。

这是新增独立运行入口。Miniclaw 原 Host 工作区继续提供通用工具，不被描述成全局只读沙箱。本方案信任宿主机操作者、Docker 管理员、Broker/执行器代码和操作系统；不声称能抵抗持有宿主机或 Docker 管理权限的恶意管理员。Unix socket 的 666 连接权限用于固定容器 UID，宿主机父目录为私有目录，socket 之外没有其他宿主机目录挂入容器。

## 签名、绑定与恢复

- Broker 只在四源实际证据成功且观察到异常指标、Unhealthy 事件、生成时间线后签发提案。目标由可信程序从当前 Pod 与应用健康接口取值，模型只提供受长度限制的说明文字。
- 提案固定 cluster=incident-lab、namespace=demo、pod=checkout-k8s、container=checkout、Pod UID、应用 instance_id、restart_count、SIGTERM/PID 1 参数、证据摘要和 run_id，10 分钟有效。
- 提案签名与人工审批采用不同 Ed25519 密钥。审批绑定整个提案 SHA256 摘要、随机 nonce、审批时刻，最长有效期 2 分钟，且不能超过提案有效期。
- 签名密钥和独立 executor ServiceAccount token 都在 Git 忽略的 data/incident-approval 下，不进入诊断容器。executor 仅 get 固定 Pod，并对该 Pod 的 exec 子资源 get/create；这是高于 reader 的专用执行权限，不称其为只读账号。
- 执行器使用固定 argv，直接运行容器内 Python，不拼接 shell。先查询当前 Pod UID、重启次数、instance_id 与故障模式；容器内部再次核对 Downward API 的 UID 和本机应用实例，然后向 PID 1 发送 SIGTERM。应用 v10 为 PID 1 注册明确退出处理器。应用使用 Kubernetes 默认 Always 重启策略，新实例应回到 healthy。
- 一次性 consumed 标记通过排他创建并 fsync 文件/父目录，在任何执行前落盘；journal 同样追加并 fsync。并发或重复执行被拒绝。实例、参数、签名或时间检查失败不会向容器发送重启。
- exec 连接中断不被直接当作失败后重试：SIGTERM 可能已成功。只发送一次动作，随后核对同一 Pod UID、restart_count 恰好增加 1、instance_id 改变、mode=healthy、Ready=True。结果未知、验证失败或进程崩溃后保留 consumed，不自动重发动作；操作者先检查现场再决定是否创建新提案。
- 模式恢复仅证明本地实验新实例的状态，不等于全服务/生产恢复。应用内存日志队列、Jaeger 内存存储等此前限制仍保留。

## 第一步：升级实验应用并准备独立组件

在已完成 v9 的项目根目录应用 v10 补丁后执行：

```bash
npm --prefix container/agent-runner run build
node --test incident-diagnosis-demo/tests/*.test.mjs incident-observability-lab/tests/*.test.mjs
python3 -m unittest discover -s incident-observability-lab/tests -p 'test_*.py'
node incident-observability-lab/kubernetes/setup.mjs
node incident-observability-lab/approval/cli.mjs setup
```

Kubernetes setup 将现有实验 Pod 的应用镜像升级为 k8s-v10，并等待新镜像容器真正 Ready。这个操作者部署动作可能增加容器重启次数，后续提案会绑定升级后的实际 restart_count。它沿用此前的只读 reader，并修复了 Docker Desktop/WSL 旧 bind mount 的问题：仅重建 Prometheus 容器并保留数据卷。

approval setup 创建独立 executor RBAC/短期 token、两把签名密钥和独立 Node/Pi 诊断镜像，不执行任何 Proposal 重启。应用镜像与诊断镜像是两个用途不同的镜像；后者安装固定版本 Pi agent-core / pi-ai 0.84.2，使用已提交 lockfile。初次构建需要下载 Node 镜像和 npm 依赖。

## 第二步：无模型集成验收，停在人工审批前

```bash
node incident-observability-lab/approval/cli.mjs diagnose
```

操作者明确启动本地 HTTP 503 故障注入，生成约 35 秒实际请求。独立容器通过受限网关依次读取 metrics/logs/traces/pod_events/timeline，验证隔离检测，再生成 pending_human_approval 提案。此默认模式是确定性的集成测试，llm_called=false，不声称调用了模型。

成功后故障模式会保留，等待人工决策；命令失败则尝试恢复 healthy。突然关闭进程/电脑时可能来不及清理，操作者可随时使用：

```bash
node incident-observability-lab/approval/cli.mjs restore
```

restore 是操作者结束本地注入，不是已审批重启，也不计为执行器恢复验证通过。

输出应包含 proposal_id、完整 proposal 和摘要、requires_human_approval=true、边界探测全部 true，以及 Docker inspect 的 network_none/root_read_only/no_privileged。先阅读目标、证据、参数和有效期；不要把出现提案等同于已批准或已执行。

## 第三步：人工审批与真实执行

使用输出的真实 UUID 替换 PROPOSAL_ID，先查看：

```bash
node incident-observability-lab/approval/cli.mjs review PROPOSAL_ID
```

确认这是你要对本地实验容器执行的动作后，运行：

```bash
node incident-observability-lab/approval/cli.mjs approve PROPOSAL_ID &&
node incident-observability-lab/approval/cli.mjs execute PROPOSAL_ID
```

approve 会再次显示提案并要求在交互终端输入完整的 APPROVE、UUID 与摘要前 12 位；输入不一致就不签名，管道输入会被拒绝。通过后 execute 立即验证审批并执行，避免 2 分钟审批票据过期。

成功返回 status=verified、重启次数恰好 +1、新 instance_id、Ready=True、mode=healthy。归档自动写入 docs/evidence/approval-restart-run.json，包含公开签名、公钥、诊断审计、证据和执行回执；不包含私钥或 token。公钥的可信身份以部署时受信配置为准，归档中的签名一致性本身不等于外部身份认证。

再次执行同一 UUID 应被拒绝且不增加重启次数。过期或已经消费的审批不可重新使用；结果未知时禁止直接删 consumed 文件绕过检查。先检查当前状态，必要时进行新诊断、创建新提案。

## 可选：真实 Pi 模型在隔离容器内诊断

先完成上述无模型集成与人工执行验收，再测试独立 Pi 循环。用交互终端私下设置 key，勿把 key 发到聊天或加入 Git：

```bash
read -rsp 'DeepSeek API key: ' INCIDENT_APPROVAL_API_KEY
export INCIDENT_APPROVAL_API_KEY
node incident-observability-lab/approval/cli.mjs diagnose --model
unset INCIDENT_APPROVAL_API_KEY
```

该模式会消耗模型额度。Pi 初始仅有 probe 工具，异常后按 Broker 阶段开放深层查询与时间线，实际观察四源并生成时间线后才开放 propose。没有 bash、文件或审批/执行工具。模型代理只走容器内 loopback → 只读挂载 Unix socket → 固定服务端 provider 请求；无真实 key 被放入容器。模型输出或执行错误不能直接触发审批。

若 key 未设置、模型没有完成提案、工具返回不足证据、socket 不可连接或隔离检测失败，流程明确失败并尝试恢复 healthy，不切回未隔离 Host 模式。

v10.1 修复 Pi 在 prompt 开始时复制工具列表后的同步问题：通过 prepareNextTurnWithContext 在下一轮更新实际循环的工具列表，保留该循环的消息与系统提示。仅修改 agent.state.tools 不能更新已运行的循环。新增真实 Pi 离线回归，验证 probe→deep→propose 的实际工具执行；不调用模型。

每轮 worker 报告（包括失败）保存在 data/incident-approval/last-worker-report.json；模型报告保留 stop_reason、error_message 与 agent_error，方便区分接口失败、正常提前结束和达到调用预算。没有提案仍然禁止执行，失败时尝试结束故障注入。该文件在 Git 忽略的私有目录中，不含真实 API key。

## 开发验证与实际验收边界

开发环境通过 104 项 Node 测试、15 项 Python 测试、Runner 构建及既有 Pi Session 阶段检查。新增测试包括：签名/摘要篡改、伪造批准、跨提案复制、过期、并发/重放、未知执行结果持久化、固定执行参数、实例变化拒绝、管道输入拒绝，以及受限网关的范围、阶段和路由规则。应用实际子进程的 SIGTERM 正常退出已验证。

当前开发环境不允许 Unix socket bind，也没有 Docker。网关测试通过仅测试用的 127.0.0.1 临时 HTTP transport 运行相同处理逻辑；正式 CLI 固定使用 Unix socket，测试 transport 不由模型或 CLI 参数开放。用户随后已完成真实 Docker/WSL socket、隔离探测、executor RBAC、人工审批重启及隔离 Pi 模型验收，见下方更新；这些本地实验结果不等于生产运行保证。Miniclaw Host 与独立容器的验收记录分别保留。

Deployment 配置回滚已完成用户本地实际验收；固定评测也已运行并保留失败与漏检修正。最新交付状态与边界见 [集中验收](../docs/INCIDENT-ACCEPTANCE.md)。参考作者的 MTTR、准确率或安全百分比不能直接使用。

官方依据与本地 SDK 指导：

- [Docker none 网络](https://docs.docker.com/engine/network/drivers/none/)
- [Docker 运行约束、挂载与权限](https://docs.docker.com/engine/containers/run/)
- [Kubernetes RBAC 与子资源](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- Pi agent-core / pi-ai：项目安装的 0.84.2 README 与类型定义；独立 worker package-lock 固定依赖。


## 用户本地实际验收更新

v10 无模型与真实隔离 Pi 模型均已完成真实人工审批重启：提案 9b351417-3b07-47d1-9d70-cf9fe7b4524b 和 8084aa8f-d30f-4d07-8456-9aec731dfecf；分别观测 restart_count 1→2、2→3、新实例 Ready/healthy，前一提案的重放返回 REPLAY_DENIED。真实模型的活动工具快照由 v10.1 修复；模型报告质量仍有聚合事件与零流量概括错误，待固定评测。开发环境的能力限制保留，用户实际结果不升级为生产恢复声明。

v11 将 Docker 固定运行边界提取为共用 isolated-runner，支持独立 release 诊断 worker；共用审批 CLI 按签名中的 action 分发重启或回滚，并分别归档。原 Host 工作区通用工具仍保持开放。
