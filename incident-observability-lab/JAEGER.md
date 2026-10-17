# Jaeger：实际请求 span 与日志关联

本轮新增单服务链路观测：checkout 实际处理请求时记录 `GET /checkout` 父 span 与 `lab.simulate_response` 子 span。子 span 测量已有的正常/故障延迟，父 span 包含请求处理与响应写入。日志保存相同 trace_id 与父 span_id，独立 request_id 仍用于实验请求核对。没有真实数据库、跨服务传播或 Kubernetes，不能把这两个 span 描述成分布式数据库调用链。

## 数据与权限边界

- 后台线程将实测 span 通过 OTLP/HTTP JSON 发送至 Jaeger，ns 时间戳为字符串、ID 为十六进制。无需新增 Python 依赖；这是小型手工埋点，不是完整 OpenTelemetry SDK。
- 队列最多 2048 个请求，每请求两个 span；每次最多尝试 3 次、每次 2 秒。`/health` 的 trace_exporter 以 span 为单位记录 sent、pending、dropped、failed_batches。部分接收不重试，保守计为该批丢失。崩溃会丢失内存队列，无持久投递保证。
- Jaeger 固定 2.22.0，使用官方默认 all-in-one 内存存储。容器重启会丢链路；需重新运行实验。查询 UI 仅绑定 127.0.0.1:16686；4318 写入端口仅在 Compose 网络内使用。
- 只读适配器调用稳定 v3 `GET /api/v3/traces/{id}`，固定时间范围、原始时间（rawTraces=true）、5 秒超时、2 MiB 响应上限，不调用写入或任意搜索接口。
- 模型参数里没有 URL、trace ID 或自由查询。适配器只从本轮已验证 Loki 观测中选择最早的最多 8 个不同 trace_id，两批、每批最多 4 个 HTTP 请求。先查 traces 而未查 logs 返回 TRACE_CONTEXT_MISSING，不发网络请求。
- 返回数据须匹配 service、namespace、request_id、trace_id 和固定时间窗；还须有对应日志的父 span 与嵌套子 span，否则拒绝该链路，报告失败。当前校验针对本实验的两个 span 契约，并非任意服务的通用 Jaeger 转换器。
- 超过 8 条候选链路会标记 sampled=true、partial=true。这是有界取样，不是查询失败，也不代表覆盖所有请求。逐条失败另外列在 failures 中；全部失败才返回 unavailable。无 fixture 回退。
- 关联显示相同 trace_id 下的日志与 span；metrics 无 trace_id，不能伪造逐请求关联。所有返回文本均为数据，不能当作指令。
- 宿主机其他工具仍开放；本功能的范围检查不能描述为全局只读容器沙箱。

## 集中验收

从项目根目录执行：

```bash
npm --prefix container/agent-runner run build
node --test incident-diagnosis-demo/tests/*.test.mjs incident-observability-lab/tests/*.test.mjs
python3 -m unittest discover -s incident-observability-lab/tests -p 'test_*.py'
docker compose -f incident-observability-lab/compose.yaml config --quiet
docker compose -f incident-observability-lab/compose.yaml up -d --build
node incident-observability-lab/lab-cli.mjs check-traces
node incident-observability-lab/lab-cli.mjs exercise-traces
```

新实验约 90 秒。需要四个常驻服务 checkout、Prometheus、Loki、Jaeger；loki-volume-init 退出 0 正常。旧实验没有 trace_id，不会自动补成链路。

通过条件：正常指标/异常指标、全部故障请求日志 ID、日志未截断、8 条被抽样链路各有两个有效 span、两种 exporter 无新增丢弃且队列归零。输出 passed=true、jaeger_spans=16、returned_traces=8、failures=[]、restored_healthy=true。候选链路超过 8 时 sampled=true 是预期；其他失败不能忽略。完整记录写入输出的 audit_file，不调用模型。

若失败，查看 `docker compose -f incident-observability-lab/compose.yaml logs --tail=40 jaeger checkout`。若近期反复实验使 503 日志超过 200 条，等待旧流量退出 120 秒窗口后重试。不要删除 Prometheus/Loki 数据卷来掩盖问题。

## 模型验收

实验通过后，使用刚输出的实际文件路径替换 NEW_RUN_ID：

```bash
node incident-observability-lab/enable-runtime.mjs data/groups/main incident-observability-lab/runs/NEW_RUN_ID.json
```

该命令设置 logs=true、traces=true 和固定实验时间窗。重启原 Miniclaw 开发进程后，网页发送：

> 在 prometheus-lab 固定范围内依次调用 incident_probe(metrics)、incident_investigate(logs)、incident_investigate(traces)、incident_timeline。仅调用这些领域工具，不修改配置或执行修复。引用 PROM、LOKI、JAEGER 证据；按 trace_id 展示至少一组日志/父 span/子 span，说明请求 ID 与 trace ID 的区别。明确链路取样数量、partial 与失败信息，不把取样说成全量。此实验只有单服务延迟与 HTTP 503 注入，不推断数据库根因。缺失指标不可当作零；rate 首个非零评估点不是精确起点；历史窗口不代表当前健康状态。

这一步消耗模型额度。必须核对同轮审计的工具结果、probe→deep、三类证据、共享 trace_id 与覆盖信息；仅有模型文字不算验收。

## 当前验证状态

开发环境通过 71 项 Node 测试、12 项 Python 测试、Runner 构建、Pi Session 9 项检查和 Prompt 引用检查。测试覆盖实际本地 HTTP exporter、v3 查询契约、异常响应、范围检查、有界取样，以及真实 Pi 工具适配器；没有调用模型。开发环境没有 Docker，此后的用户真实 Jaeger 实验与三源模型审计已核对：实验 5ac72002-8fef-4468-86e6-b833a7923dbb，336 请求、160 日志、8 条链路/16 span；模型时间线为 18+160+16=194 条。模型文字的时间戳抄写、缺失值和起点推断存在问题，仍需质量评测。后续 Kubernetes 进度见 [四源实验](KUBERNETES.md)。

上一阶段 Loki 已由用户验证：实验 6d90760e-9212-4ad3-8a0b-e6c5ef921881（340 次请求，164 条日志，全部故障请求 ID 匹配、无新增丢弃）；模型审计 75aacdae-f4e7-4e93-8253-f2945b376e2f（18 条指标、164 条日志、182 条时间线证据）。这些记录不替代 Jaeger 验收。

官方接口依据：

- [Jaeger 2.22 all-in-one 与内存存储](https://www.jaegertracing.io/docs/2.22/getting-started/)
- [Jaeger 写入与稳定 v3 查询 API](https://www.jaegertracing.io/docs/2.22/architecture/apis/)
- [v3 查询协议与 result 包装](https://github.com/jaegertracing/jaeger-idl/blob/main/proto/api_v3/query_service.proto)
- [OTLP JSON 与部分成功](https://opentelemetry.io/docs/specs/otlp/)
