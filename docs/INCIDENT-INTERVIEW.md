# 面试讲解提纲

先理解整体，再逐个打开函数说明。代码由 Codex 辅助开发，应能解释自己实际操作、核对与发现的问题，不把上游能力说成独立从零实现。

## 一分钟介绍

我基于 Miniclaw/Pi 二次开发了一个本地服务故障诊断演示。模型先查指标，观察到异常后才开放日志、trace 和 Kubernetes 事件查询，用证据 ID 和共享标识生成时间线。查询范围、预算和失败熔断由程序控制。另一条独立容器流程允许模型提出重启建议，人工签名后固定执行器才操作，并核对真实实例与健康状态。配置回滚使用单独 Deployment 实验验证。最后用 8 个固定用例评测，保留了模型时间计算错误和结构化输出问题。

## 八个核心问题

**1. Pi、Skill、Harness 分别是什么？**

Pi 提供模型—工具循环及会话运行机制。Skill 提供任务流程、使用规则和参考材料。Harness 通过程序管理阶段、范围、预算、结果与审计；写在 Skill 里的“不要越界”不能代替执行前检查。本项目的 IncidentHarness 是故障领域工具 Broker，不是整个 Host 的沙箱。

**2. 为什么先 probe 再 investigate？**

先用低成本指标判断本窗口是否存在异常，再开放较深证据查询。工具列表和执行函数同时检查阶段。调试时发现 Pi 在 prompt 开始复制工具列表，仅改 agent.state.tools 不会更新活动循环，最终通过 prepareNextTurnWithContext 更新下一轮真实上下文。

**3. 如何避免模型编造证据？**

工具返回 source、evidence_id、scope 与时间；时间线只读取 Harness 保存的查询副本。模型不能提交任意 evidence 让程序当成观测。评测检查引用是否存在，再读文字判断引用是否真的支持结论。存在的 ID 并不保证一句话正确。

**4. 四源如何关联？**

Prometheus 给服务级症状，Loki 提供请求日志，Jaeger 给父子 span，Kubernetes 提供 Pod 事件和当前快照。日志与 span 以 trace_id 关联，父子以 parent_span_id 关联，同一 Pod 实例以 pod_uid 关联。实际实验抽取 8 条链路，不宣称全量，也不把时间相近直接说成根因。

**5. 模型怎么被限制为不能修复？**

原 Host 工具仍开放，所以另建诊断容器：network none、只读根目录、非 root，无 Kubernetes 凭据、Docker socket 或审批密钥。唯一 socket Broker 只暴露固定读取、模型代理和提案路由。真正的批准/执行在可信宿主机外部组件中完成；宿主机和管理员仍是可信主体。

**6. 为什么不接受 approved=true？如何防重复？**

模型字段不是授权。提案摘要绑定具体动作、目标身份、参数与证据，人工用不同 Ed25519 密钥签名。执行前先持久化一次性消费记录。响应丢失可能表示动作已发生，因此后续只读验证，不能自动重发；验证不清楚时保留“结果未知”。

**7. 重启和回滚的成功依据是什么？**

重启检查同一 Pod UID、重启次数恰好 +1、新 instance_id、healthy/Ready。配置回滚使用原子条件 patch 恢复批准模板，再检查 Deployment 身份、新 Pod Ready 和 HTTP 200×3。revision 变为更高值是新的修订记录，并非退回旧数字。回滚实验与四源模型重启分别验证。

**8. 评测有什么发现？为什么没有写 100%？**

最初 3/8，输出契约不清楚；明确契约后原自动 7/8。但读取原始 JSON 发现一次重复键被 JSON.parse 合并，修复漏检后同一回答离线复核为 6/8。另一例日志比 span 结束早 0.684113ms，模型却读成晚。我们保留原文、错误及评分器修正，不用刷重试获得漂亮分数。固定公开 8 例不是生产准确率，精确比较由程序与原始记录核对。

## 代码阅读顺序

1. incident-diagnosis-demo/scripts/incident-harness.mjs：availableTools、dispatch/dispatchAsync、权限写入、预算/熔断、阶段转换。
2. container/agent-runner/src/incident-tools.ts：工具注册和 Runtime 接入；再看各真实适配器的固定查询入口。
3. incident-observability-lab/approval/worker/model-state.mjs：活动工具快照；isolated-runner.mjs：Docker 约束。
4. approval/store.mjs：提案、签名、审批与 consumed；executor.mjs / rollback.mjs：固定动作和实测验证。
5. incident-eval/runner.mjs、grade.mjs 与 docs/evidence：用一个真实失败例解释“程序通过”和“模型说对”的区别。

下一步学习优先讲清这五段，不必背完整源码或一次掌握所有上游功能。能从一次输入说明工具怎么执行、什么会被拒绝、证据在哪落盘、为什么判定成功，就是可核查的工程理解。
