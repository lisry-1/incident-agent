# 分阶段故障诊断与时间线对齐

对应目标：参考项目中的“探活层 / 深层排查动态工具集”和“Timeline Alignment”。本轮实现与验证使用合成数据，未接入真实 Prometheus、Loki、Jaeger 或 Kubernetes。

## 程序控制流程

| 阶段 | 对模型开放的领域工具 | 转换条件 |
| --- | --- | --- |
| probe | incident_probe | 本次查询观测到 http_5xx_ratio > 0.10 后进入 deep |
| deep | incident_investigate、incident_timeline | 可查日志、部署、Pod 事件、trace；生成时间线后由模型输出报告 |
| complete | incident_timeline | 探活成功但未观测到阈值越界；报告范围和缺口，不宣称整体健康 |

表中工具在 Pi 中带 mcp__miniclaw__ 前缀。探活 unavailable/error 时停留在 probe，重复失败受熔断与请求预算约束。complete 表示本次证据收集停止，不是业务服务已恢复。

- 初始 Session 配置在首次 prompt 前隐藏深层工具，探活成功后更新实际 Pi 活跃工具列表，供后续模型轮次使用。
- 执行函数也检查阶段，因此旧工具引用或直接执行深层 handler 不能绕过阶段门禁。
- staged 模式不注册原 incident_query。其他通用工具保持原状态；这不是全局只读或网络沙箱。
- 所有领域请求共享每次 runTurn 默认 12 次预算。阶段状态和观测证据仅在该运行内存在，不支持跨运行恢复；同一 runTurn 内接收的后续输入共享状态。
- 阶段转换写入同一个 JSONL，事件类型 stage_transition，记录 from/to、触发 attempt 和阈值规则。转换事件中的 stage 是转换前阶段，to 是新阶段。
- 阶段说明随工具返回结果和可用工具列表更新，尚未实现根据阶段压缩全部历史上下文。

## 时间线算法

incident_timeline 无参数，只读取本次运行通过查询获得的证据；不接受模型自行传入的证据，也不自动补查数据。

1. 校验查询作用域与事件时间，使用毫秒精度 UTC；区间为 [start, end)。
2. 以 source + evidence_id 去重；同一标识出现冲突内容时返回错误。
3. 按 timestamp_ms 排序，同一时间按来源与 ID 确定稳定顺序。
4. 以固定查询窗口的起点划分 60 秒片段，保留精确事件时间。
5. 按相同 trace_id、pod、version 组织关联组，关联可跨时间片。时间相近或共享标识均不等于已证明因果。
6. 返回每个数据源实际查询的 start/end/status，以及尚未查询的数据源，避免把数据缺失解释为健康。

发布回归样例现在共有 8 条记录：2 条指标、2 条日志、1 条部署、2 条 Pod 事件、1 条 trace。原模式的历史审计包含当时的 5 条结果，保留为历史记录，无需重写。

## 安装后验证（无需模型额度）

在项目根目录执行：

```bash
npm --prefix container/agent-runner run build
node --test incident-diagnosis-demo/tests/*.test.mjs
node incident-diagnosis-demo/scripts/runtime-smoke.mjs
node incident-diagnosis-demo/scripts/staged-runtime-smoke.mjs
```

当前结果：41 项程序测试、原模式 9 项检查、新模式 9 项检查通过。新模式检查创建实际 Pi Runtime Session，并直接执行工具，确认活跃工具列表切换；没有发送模型 prompt，不等于已完成网页端模型验证。

全仓门槛限制：此次开发环境未安装根目录依赖，format:changed 和 make test 无法启动对应本地工具；make typecheck / make build 在上游 sync-stream-event.sh 的执行权限处中止。已使用固定版本 Prettier 格式化本轮代码，Runner 独立编译、相关测试和 docs:check 通过。尚不能宣称全仓构建与测试通过。

## 启用（上述检查通过后）

Home 工作区使用 Host 模式。将现有配置改为：

```bash
printf '%s\n' '{"case_id":"release-regression","workflow":"staged"}' > data/groups/main/incident-demo.config.json
```

在原开发服务终端按 Ctrl+C 后重新运行 `npm run dev:all`。不要重复启动第二个服务。新的 Runner 会重新创建阶段状态。

向网页发送：

```text
请按当前分阶段工具完成 release-regression 的诊断。
service: checkout-api
namespace: demo
start: 2026-10-15T10:00:00Z
end: 2026-10-15T10:15:00Z

先用 incident_probe 查询 metrics。若开放深层工具，分别查询 logs、deployments、pod_events、traces，再调用 incident_timeline。
所有工具带 mcp__miniclaw__ 前缀。请仅使用这些领域工具。
基于工具实际返回的时间线，给出故障时间线、最可能原因、证据 ID、缺口和验证建议。
明确数据是合成样例，不执行修复，不把关联当作因果；被拒绝时报告实际错误，不绕过控制。
```

验收：同一个 run_id 下有一次 probe→deep 转换、5 次数据查询和1次 timeline 执行；时间线有8条证据；报告引用结果且说明不确定性。若有额外请求，逐条检查原因，不只看总数。原来的正常查询和越界网页证据不能代替这一轮的新模式模型验收。

## 回到原模式

将配置改回 `{"case_id":"release-regression"}` 并重启原服务即可；不用卸载代码或删除历史审计。

## 下一阶段

真实四类数据源适配、本地实验环境、独立诊断隔离、Proposal / Approval 受控执行和批量模型评测仍按 docs/RESUME-TARGET.md 推进。
