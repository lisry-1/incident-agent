# Kubernetes：同一实验服务的四类证据

本轮把 checkout 应用另部署到专用 kind 集群 incident-lab / namespace demo / Pod checkout-k8s。Compose 中的 Loki、Jaeger、Prometheus 继续使用；原 Compose checkout 保留供旧实验使用。Kubernetes 模式使用独立 checkout-k8s-lab 标签与 18081 端口，避免把两个服务的日志、指标混在一起。

## 拓扑与实验行为

kind 单节点通过 Docker 运行，固定 kind 0.33.0 / Kubernetes 1.37.0，并按官方 release 固定 node 镜像 digest。节点加入已有实验 Compose 网络；Pod 通过 hostAliases 指向该网络内的 Loki/Jaeger 地址，Prometheus 通过节点 NodePort 抓取 Pod 指标。地址由 setup 从实际 Docker 状态取得，不写死容器 IP。

Pod 使用同一应用镜像，日志和 OTLP resource 增加由 Downward API 提供的 Pod 名称、UID。只读事件适配器核对同一 UID，时间线增加 pod_uid 共享身份分组。指标按独立 job 关联到实验工作负载；指标样本本身不包含 trace_id，也不能被描述成逐请求链路关联。

/ready 在正常模式返回 200，故障模式返回 503；/health 继续存活。真实 kubelet readiness probe 会产生 Unhealthy 事件、将 Pod Ready 置为 False。实验 Service 故意设置 publishNotReadyAddresses=true，保证未就绪期间仍能持续注入流量和抓取指标。这是实验设置，不能表述为普通生产 Service 的默认故障行为。

## 只读权限与数据范围

- 专用 ServiceAccount incident-reader：只允许 get demo 中名为 checkout-k8s 的 Pod，以及 list demo 中的 core/v1 Events。Events 的 RBAC 许可作用于整个 demo 命名空间；程序另外固定过滤 Pod 名称和 UID。账号没有 Pod 修改、删除、exec、Secret 或其他命名空间的读取权限。默认的 API discovery / 自助权限查询能力仍可能存在。
- setup 是操作者执行的环境部署命令，使用独立 admin kubeconfig；模型工具只读取私有 reader.json 中的短期 token 和集群 CA，经 HTTPS 调用两个固定 GET 路径。不读取用户默认 kubeconfig，不执行 kubectl/exec 插件，不允许模型指定 URL、凭据文件或 Pod 名称。
- admin.yaml、reader.json 与下载的工具均保存在 Git 忽略的 data/incident-k8s 下。reader.json 权限必须为 600，token 不进入提示词、查询参数、审计或实验报告。API 验证真实 token；客户端预先检查身份及过期时间。token 申请 8h，实际有效期由 API Server 决定；过期后由操作者重新运行 setup，不由模型自动提权。
- Pod 被替换后 UID 改变，旧配置会明确拒绝，不把同名新 Pod 当作原实例；重新 setup 后再进行新实验。
- GET 超时 5 秒、响应最多 2 MiB、事件最多 100 条；额外请求一条并检查 continue 标记。范围错误、TLS/认证错误不会返回夹带凭据的上游正文。
- Event 是尽力保留、可过期、可聚合的数据。保留 count、first_observed_at、last_observed_at 和纳秒时间，按聚合记录的最后观测时间过滤固定半开窗口，不展开成虚构的逐次事件。截断明确标 partial。
- current_snapshot 是查询时刻的真实 Pod 状态，独立于历史 evidence；不把现在的 Ready 状态回填到过去的时间线。实验另在正常、故障、恢复三个阶段当场采样，分别保存观察时间。
- 此处是领域工具与 Kubernetes 账号的限制。Miniclaw Host 通用工具仍开放，实验控制接口也仍供操作者使用；独立诊断沙箱和审批执行尚未完成。

## 集中安装与验收

先应用 v9 补丁，在项目根目录执行：

```bash
npm --prefix container/agent-runner run build
node --test incident-diagnosis-demo/tests/*.test.mjs incident-observability-lab/tests/*.test.mjs
python3 -m unittest discover -s incident-observability-lab/tests -p 'test_*.py'
docker compose -f incident-observability-lab/compose.yaml up -d --build
bash incident-observability-lab/kubernetes/install-tools.sh
node incident-observability-lab/kubernetes/setup.mjs
node incident-observability-lab/lab-cli.mjs check-kubernetes
node incident-observability-lab/lab-cli.mjs exercise-kubernetes
```

工具安装无需 sudo，不修改全局 PATH 或系统 kubectl；从官方固定版本地址下载并验证 SHA256。setup 创建本地集群、加载本地应用镜像、部署 Pod/RBAC/Service，创建短期只读凭据并核验九项实际权限，最后重启 Prometheus 加载新增抓取 job。首次需要下载集群镜像。操作不会自动删除已有集群或数据卷；失败时保留环境供检查。

实验正常与故障阶段各生成约 45 秒请求，最后恢复 healthy，并等待 Pod Ready=True。检查 passed=true、rbac_passed=true、same_pod_uid_across_sources=true、healthy_pod_ready=True、fault_pod_ready=False、restored_pod_ready=True，且实际查到 Unhealthy / 503 事件。其他指标/日志/链路条件沿用此前验收：故障请求 ID 全部匹配、8 条取样链路/16 个 span、无新增 exporter 丢弃。链路 partial=true 因取样仍属预期；事件或日志截断不能忽略。

故障窗口的截止点包含实际观察到的恢复边界，指标不一定仍为 100% 5xx，验收要求故障窗口末端的 30 秒速率比例至少 10%。phase_snapshots 记录各阶段当时的 Pod Ready，不能用它推断未来健康。

完整实验记录写入输出的 audit_file。上述命令不调用模型。Kubernetes Events 的实际数量由调度和聚合决定，不预设条数。

若失败，集中查看：

```bash
docker compose -f incident-observability-lab/compose.yaml ps -a
./data/incident-k8s/bin/kubectl --kubeconfig data/incident-k8s/admin.yaml --context kind-incident-lab get pod checkout-k8s -n demo -o wide
./data/incident-k8s/bin/kubectl --kubeconfig data/incident-k8s/admin.yaml --context kind-incident-lab get events -n demo --sort-by=.metadata.creationTimestamp
```

请勿粘贴 admin.yaml、reader.json 或 token。若 Loki/Jaeger 重建后 IP 改变，已有 Pod 的 hostAliases 不会自动更新；setup 的 apply 会明确失败，需操作者按报错检查并重建该实验 Pod，再重新绑定 UID。不能以旧 Pod 身份继续新实验。

## 启用模型与归档

成功后，将 NEW_RUN_ID 换成实际输出的实验 UUID：

```bash
cp incident-observability-lab/runs/NEW_RUN_ID.json docs/evidence/kubernetes-lab-run.json
node incident-observability-lab/enable-runtime.mjs data/groups/main incident-observability-lab/runs/NEW_RUN_ID.json
```

配置增加 kubernetes=true、logs=true、traces=true，并固定新实验窗口。重启原 Miniclaw 开发进程，然后在网页发送：

> 在固定 prometheus-lab 范围内依次调用 incident_probe(metrics)、incident_investigate(logs)、incident_investigate(traces)、incident_investigate(pod_events)，最后 incident_timeline。只调用这些工具，不改配置或执行修复。引用本轮 PROM、LOKI、JAEGER、KUBE 证据，核对日志、span、事件的 pod_uid。分别说明历史 Event、查询时 current_snapshot 与实验阶段快照，不混用观察时间。保留链路抽样、事件聚合/缺失和指标 partial；不把缺失值当零。使用工具返回的 span 耗时，不编造时间戳。部署源未接入时如实说明。

模型调用消耗额度。验收需要同轮审计：probe→deep、三次 investigate、timeline，四类来源与 UID 对齐；原始历史事件必须来自实际 API。模型回复需另行检查数值与证据引用。

## 已验证与待验证

开发环境通过 81 项 Node 测试、14 项 Python 测试和 Runner 构建；包括真实本地 HTTPS/TLS 查询、范围拒绝、凭据不入审计、RBAC 自助查询协议、聚合与窗口边界、实际 Pi 四源适配和旧模式兼容。开发环境没有 Docker，因此真实 kind 集群启动、网络接线、实际 kubelet 事件、RBAC 及四源模型诊断均待用户本地运行验收，不能计为已通过。

上一阶段三源实验 5ac72002-8fef-4468-86e6-b833a7923dbb 已通过：336 请求、160 日志、8 条取样链路/16 span、无新增丢弃。用户模型审计已核验 18+160+16=194 条时间线证据并保存。原始 span 耗时正确；模型报告抄错时间戳、误读缺失指标及过度限定故障起点，仍列入后续质量评测。

官方依据：

- [kind 固定版本及节点镜像 digest](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0)
- [kind NodePort 与额外端口映射](https://kind.sigs.k8s.io/docs/user/configuration/)
- [Kubernetes RBAC 与 resourceNames](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [ServiceAccount 短期 token](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [core/v1 Event 与聚合字段](https://kubernetes.io/docs/reference/kubernetes-api/core/event-v1/)
- [EndpointSlice 的就绪语义](https://kubernetes.io/docs/reference/kubernetes-api/discovery/endpoint-slice-v1/)
