# Deployment 配置版本回滚验收

本轮补齐本地 Deployment 回滚：健康修订的实际 HTTP 基线 → 发布故障配置 → 独立容器观察并提出 Proposal → 人工二次签名 → 原子恢复已批准 Pod 模板 → 验证新 Pod 与 HTTP 恢复。

## 实验范围

Deployment 固定为 incident-lab / demo / checkout-release，单副本、Recreate 策略。独立标签 app=incident-checkout-release，不进入现有 checkout-k8s Service 的选择范围。实验的两个配置修订共用 incident-checkout:k8s-v11 镜像：stable-v1 启动 healthy，regression-v2 通过 LAB_INITIAL_MODE 启动 fault。这是实际 Kubernetes Pod 模板配置回滚，不宣称两个不同业务二进制版本或生产滚动发布。

既有 checkout-k8s 的四源模型诊断与重启已经由用户实际验证。本轮新 Deployment 使用 Kubernetes Deployment / ReplicaSet / Pod 及实际 HTTP 200/503 证据；没有将此前四源证据移植过来，也不称它为该 Deployment 的四源模型诊断。默认 llm_called=false，不调用模型。发布历史与回滚执行是本轮验收重点，模型报告质量继续在固定评测环节处理。

## 可信边界和执行条件

- 复用现有两把 Ed25519 密钥、交互式人工审批和 durable consumed 记录。重启与回滚的 action、target、parameters、证据摘要都参与签名；审批不能跨动作复用。
- 诊断仍在 network none、非 root、只读根目录的独立容器中，通过只读挂载 Unix socket 请求固定 release/observe 和 release/propose。无模型、审批、执行、任意 API 或 shell 路由。
- 宿主机 Broker 持 reader token；独立 executor token 只有 get 固定 Deployment、namespace demo 内 Pod / ReplicaSet 读取、get 固定 Service proxy 和 patch 固定 checkout-release 的权限。namespace 内 Pod / ReplicaSet 的 list 权限不是由标签实现的 RBAC 隔离，可信 Broker 固定选择器；不称为只能读取一个 Pod 的账号。
- Service 仅 ClusterIP，不新增宿主机端口。publishNotReadyAddresses 用于明确的本地坏版本观测；经固定 Kubernetes Service proxy 测量 /health 与 /checkout。诊断路由不接受服务名、URL、HTTP 方法或命名空间参数。GET proxy 权限本身不是按路径隔离，应用与固定 Broker 路径也属于可信边界。
- 健康基线需实际三次 HTTP 200；故障修订需同一当前 ReplicaSet 的 Pod Ready=False、health 身份匹配、三次实际 HTTP 503。上一个健康 ReplicaSet 必须属于该 Deployment，模板摘要与测得健康基线一致。
- 提案绑定 Deployment UID、generation、当前 revision/模板摘要，以及目标 ReplicaSet 名称、UID、revision/模板摘要。模型或 worker 不能提交一个自选模板。
- 执行重新读取对象，拒绝 UID、generation、当前模板、历史模板或修订变化。唯一写请求是 JSON Patch：先 test UID、resourceVersion、generation、replicas 与完整当前模板，再 replace spec.template 为已签名摘要对应的历史模板。发生并发冲突不自动重发。
- 成功必须同一 Deployment UID、generation 恰好 +1、已观测到新 generation、恢复完整健康模板、目标 ReplicaSet 的新 Pod Ready、旧 Pod UID/instance_id 已更换，以及三次 HTTP 200。Kubernetes 回滚会产生更高 revision，不要求把 revision 数字减回旧值。
- API 响应丢失时只读验证实际结果；不再发第二次 patch。结果未知、超时或失败均保留 consumed。宿主机、控制面和持有 Docker/admin 权限的操作者仍为可信主体。

## 1. 准备组件

应用 v11 增量补丁后，在项目根目录执行：

```bash
node incident-observability-lab/approval/release-cli.mjs setup
```

该操作者命令构建/加载应用镜像、配置专用 reader/executor 与 8 小时 token、验证真实 RBAC、创建健康 Deployment/Service 并测量 HTTP 200，再重建共用隔离诊断镜像。保留现有签名密钥。输出 status=configured、release_rbac_passed=true。已有四源实验服务保持各自配置，不因这一步迁移为 Deployment。

## 2. 生成待审批回滚提案

```bash
node incident-observability-lab/approval/release-cli.mjs exercise
```

操作者先重新验证健康配置，再部署 regression-v2，独立诊断容器观察 API/HTTP 后生成 pending_human_approval。成功后故障配置保留，等待人工审批；失败时尝试恢复 healthy 配置。新提案仍然 10 分钟有效，人工审批仍最长 2 分钟有效。

## 3. 人工审批与实际回滚

使用本轮输出的真实 UUID 替换 PROPOSAL_ID：

```bash
node incident-observability-lab/approval/cli.mjs review PROPOSAL_ID
node incident-observability-lab/approval/cli.mjs approve PROPOSAL_ID &&
node incident-observability-lab/approval/cli.mjs execute PROPOSAL_ID
```

approve 显示具体 action、目标和证据摘要。确认后输入它要求的 APPROVE / UUID / 摘要前 12 位，execute 才能继续。成功返回 status=verified、release=stable-v1、mode=healthy、ready=true 和 http_statuses=[200,200,200]。证据自动保存 docs/evidence/approval-rollback-run.json，包括公开签名、公钥、证据和回执；不包含 token 或私钥。公开密钥的身份信任仍依赖受信的部署配置。

验证重复执行同一提案被拒绝，不能再产生一个回滚。审批过期或动作结果未知时不要删除 consumed 或自动重试，应检查当前对象并重新诊断。

## 操作者停止实验

```bash
node incident-observability-lab/approval/release-cli.mjs restore
```

此命令由操作者直接重新部署健康配置，属于结束实验，不计为已审批执行器成功。突然关闭终端/电脑时可能来不及清理，可以恢复后使用它。token 到期后重新运行 setup；该命令也会将实验配置部署为健康状态。

## 开发检查与实际验收

122 项 Node、16 项 Python 测试、Runner 构建通过；新增回滚检查包含错误历史/目标、签名与重放、原子 patch 条件、TLS API 请求、并发冲突、丢响应及 HTTP 恢复失败。应用独立进程已验证可由环境配置启动成真实 503。测试服务器和合成 Kubernetes 对象不是实际集群集成结果。

当前开发环境没有 Docker，正式 Unix socket 也无法 bind；同处理逻辑的本地 HTTP 测试 transport 仅用于测试。用户已经在本地通过 v11 setup/exercise/approve/execute：提案 c177a358-0f93-4ae3-aa6e-ce62d5c56ddf 的真实 RBAC、Service proxy、独立 worker、人工签名及 Deployment 回滚均完成；回执 verified，revision 2→3，恢复已批准模板，新 Pod Ready，三次 HTTP 200。该证据是确定性实验，llm_called=false，保存于 docs/evidence/approval-rollback-run.json。固定模型评测及交付说明现已补齐，保留格式与时间比较失败；见 [集中验收](../docs/INCIDENT-ACCEPTANCE.md)。不继续增加业务功能。

官方依据：

- [Deployment 修订与回滚](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [集群 Service proxy](https://kubernetes.io/docs/tasks/access-application-cluster/access-cluster-services/)
- [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
