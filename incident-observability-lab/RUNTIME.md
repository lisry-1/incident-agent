# Prometheus → Pi 分阶段诊断

当前实现：Host 工作区启用 `case_id: prometheus-lab` 后，incident_probe 经异步 Harness 调用实际 Prometheus HTTP 适配器。现有 fixture 配置继续兼容。

## 行为与边界

- 仅连接本地 `http://127.0.0.1:19090`，模型不能传 URL 或 PromQL。
- 每次运行固定 case、service、namespace、时间窗。默认回看 300 秒；可由可信配置指定 end，用于复查历史实验。时间窗在本次运行中不会随模型调用移动。
- 六个工具参数仍为 case/source/service/namespace/start/end，必须来自注入的 pinned scope。
- 所有请求（含拒绝）计入 12 次预算。完全失败的相同查询两次后熔断。异步请求排队，避免并发绕过阶段和熔断；四个固定 Prometheus 子查询计作一次领域工具执行。
- permission 必须落盘后才能查询；tool_result 和 stage_transition 写入同一 incident-audit JSONL。拒绝发生时不发送 HTTP 请求。
- 观测 5xx > 10% 解锁 deep。无异常且 partial/empty 时保持 probe，不能宣称健康；预算仍限制重复尝试。
- 未启用 logs 时，日志返回 SOURCE_NOT_CONFIGURED；可信配置 logs=true 后查询 Loki 的 HTTP 503 请求日志。deployments/pod_events/traces 仍返回 SOURCE_NOT_CONFIGURED，不读 fixture，不声称已完成多源诊断。
- timeline 只对本次观察到的证据对齐，保留 live_lab、partial 和各指标覆盖状态。历史窗口异常不等于服务目前仍故障。
- 此领域代理不是全局沙箱；Pi 通用工具仍按原有策略开放。修复提案、人工审批、受控执行尚未实现。

## 验证和启用

先构建并测试：

```bash
npm --prefix container/agent-runner run build
node --test incident-diagnosis-demo/tests/*.test.mjs incident-observability-lab/tests/*.test.mjs
node incident-diagnosis-demo/scripts/staged-runtime-smoke.mjs
```

使用已通过的实验记录设置时间窗（这里只读时间窗，不加载证据）：

```bash
node incident-observability-lab/enable-runtime.mjs data/groups/main docs/evidence/prometheus-live-lab-run.json
```

旧配置会在同目录生成带时间戳的备份。新配置仍在忽略的 data/ 目录，不要提交。启用脚本不调用模型、不生成流量、不注入故障。

Prometheus 保留 6 小时指标。若该实验已超过保留期，重新运行 lab-cli.mjs exercise，再用其输出的 audit_file 启用；不能用 JSON 中保存的证据冒充实时 HTTP 查询。

关闭原 Miniclaw 开发终端进程（Ctrl+C），再在原终端运行：

```bash
LOG_LEVEL=debug npm run dev:all
```

在网页发送：

> 使用本轮注入的 prometheus-lab 固定范围，先调用 incident_probe；若解锁深层阶段，再查询一次 logs 并生成 incident_timeline。只用本轮工具证据，不引用早前 REL-* 模拟证据，不调用 bash 或其他工具，不修改配置、不执行修复。报告数据模式、观察窗口、5xx 异常、缺失证据，并区分实验历史异常与当前健康状况。未接入的数据源如实说明，不重试。

这一步会调用配置的真实模型，消耗少量 API 额度。应核查对应审计：data_mode=live_lab，incident.probe 包含 PROM-* 证据；异常时有 probe→deep，logs unavailable，timeline 无 REL-*。没有实际模型输出与对应审计前，不算端到端验收通过。

## 开发验证记录

开发环境：Runner TypeScript 构建通过，原 41 项测试、15 项适配器/异步 Runtime 测试、原 Pi Session 9 项检查通过。新增 Runtime 测试通过真实 Pi 工具转换器调用，HTTP 响应由测试替身提供；它不等同于实际 Prometheus 或真实模型端到端测试。用户上一轮已验证 Compose 的指标抓取和 336 次实际请求实验。

本轮没有修改全栈依赖。全仓 typecheck/test/build 门槛仍受开发环境缺少根依赖与旧脚本执行权限限制；不将局部构建结果写作全仓通过。

## Loki 日志模式

执行 [日志验收](LOKI.md) 后，用其新审计文件运行 enable-runtime.mjs，会保留 case_id=prometheus-lab 并启用 logs=true；此前的纯指标审计仍启用 metrics-only。旧配置继续兼容，不会默认读取后来才建立的 Loki。

纯指标真实模型验收已由用户完成：run ec96d90b-182a-4924-80db-ad702cecd823，18 条 PROM-* 证据，probe→deep、logs SOURCE_NOT_CONFIGURED、timeline 18 条。模型文字曾把首个非零 rate 点当作精确故障起点、混淆历史与当前；本轮 Prompt 已补充两项规则，但改善效果需真实模型验收，不能仅据 Prompt 修改宣称已修复。

本轮开发检查：63 项 Node 测试、7 项 Python 测试、原 Pi Session 9 项检查及 Runner 构建通过。新增 Loki 测试使用本地 HTTP 协议服务器，包含实际 checkout 响应→异步日志 POST 的 request_id 对照；开发环境没有 Docker，真实 Loki 容器与日志模型端到端仍需本地验收。
