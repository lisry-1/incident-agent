# 故障诊断演示：运行与验证

本目录提供合成故障数据、查询工具、IncidentHarness 和测试。当前分支已包含 Runtime 接入代码，使用当前分支时无需再次应用 integration/ 中的历史补丁。

## 新增分阶段模式

[分阶段模式说明与启用步骤](STAGED-WORKFLOW.md)。不指定 workflow 时继续使用原有查询模式；原有网页验证记录对应原模式。

## 运行方式

从仓库根目录运行。已验证环境为 WSL2 Ubuntu、Node.js 24，以及已安装的根目录、web、container/agent-runner 三组 npm 依赖。首次安装参见根目录的上游安装说明；原生依赖编译需要 Python、make 和 C/C++ 编译器。

### 无模型检查

```bash
node --test incident-diagnosis-demo/tests/*.test.mjs
npm --prefix container/agent-runner run build
node incident-diagnosis-demo/scripts/runtime-smoke.mjs
```

查询、Harness、阶段和时间线测试共 41 项；适配器检查共 9 项。适配器检查直接调用实际 Pi 工具执行函数，使用临时工作区，不发起模型请求。

独立演示仍可运行：

```bash
node incident-diagnosis-demo/scripts/incident-cli.mjs demo
node incident-diagnosis-demo/scripts/incident-harness.mjs demo
```

两者均输出 llm_called=false。独立 CLI 查询不经过 Harness；验证 Runtime 约束时应使用注册工具。

### 网页与模型诊断

1. 启动 `npm run dev:all`，打开 http://localhost:5173/，完成管理员初始化，将目标工作区设为 Host 模式。
2. 在模型配置中设置兼容当前 Runner 的 Provider、模型及有效 API Key。真实模型请求会使用 Provider 额度。
3. 在目标工作区创建 incident-demo.config.json。Home 示例：

```bash
mkdir -p data/groups/main
printf '%s\n' '{"case_id":"release-regression"}' > data/groups/main/incident-demo.config.json
```

4. 停止原开发服务后重新启动 `npm run dev:all`，让 Runner 重新加载工具。保持该终端打开，在 Home 对话中发送下面的提示词。

```text
请仅使用 mcp__miniclaw__incident_query，分别查询 metrics、logs、deployments。
case: release-regression
service: checkout-api
namespace: demo
start: 2026-10-15T10:00:00Z
end: 2026-10-15T10:15:00Z

根据实际返回的证据生成故障时间线、最可能原因、尚不能确认的地方和下一步验证建议。
引用 evidence_id，明确数据为模拟样例。将已观测事实与原因假设分开。
不要执行修复操作，不要使用其他工具。工具不可用时直接说明。
```

预期取得 REL-M1、REL-M2、REL-L1、REL-L2、REL-D1 五条证据。连接池配置从 30 降至 3 与超时在时间上相关，可作为待验证的原因假设；不能仅凭这组样例宣称已证明因果。

### 越界拒绝验证

```text
对本地模拟工具做一次拒绝路径测试。
仅调用一次 mcp__miniclaw__incident_query：
case: release-regression
source: metrics
service: checkout-api
namespace: production
start: 2026-10-15T10:00:00Z
end: 2026-10-15T10:15:00Z

如果被拒绝，报告错误码后停止。不要改参数重试、使用其他工具或修改配置。
```

预期程序返回 SCOPE_DENIED。模型自行拒绝调用不构成程序拦截证据；必须核对审计中的 decision=deny 和 tool_executed=false。

## 实际验证证据

以下两次真实模型运行已在网页中完成，并逐条核对本地 JSONL；数据源均为 synthetic_fixture。

| 场景 | run_id | 审计结果 |
| --- | --- | --- |
| 正常诊断 | 9ca2533a-b19e-4cf5-ad49-30ba10952fab | 3 条 allow + 3 条 tool_result，均为 ok，共 5 条证据 |
| 越界查询 | 5c3e65ce-a707-4fc4-870b-19d135a8f33a | 1 条 deny，SCOPE_DENIED，tool_executed=false，无查询结果记录 |

验证时间：2026-10-17（UTC+8），JSONL 内时间使用 UTC。

归档文件位于仓库根目录的 docs/evidence：

- `release-regression-model-run.jsonl`
- `production-scope-denied-model-run.jsonl`

运行时原始文件位于 `data/groups/main/incident-audit/<run_id>.jsonl`。归档 JSONL 记录工具权限与结果，不包含模型完整回答；报告内容需结合网页对话检查。

本次报告正确引用五条证据并说明因果尚待验证。仍需改进的表述包括：把“首次错误”改为“样例中最早观测到的错误”；扩大时间或服务范围属于后续方案，当前固定范围的工具无法直接执行。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| scripts/incident-cli.mjs | 查询固定样例、校验参数、返回证据 |
| scripts/incident-harness.mjs | 范围检查、失败计数、请求预算、JSONL 审计 |
| fixtures/*.json | 发布回归、上游超时、证据不足三组样例 |
| tests/*.test.mjs | 查询与 Harness 程序测试 |
| scripts/runtime-smoke.mjs | 实际 Pi 适配器检查，无模型推理 |
| ../container/agent-runner/src/incident-tools.ts | 按工作区配置创建受控工具 |
| ../container/agent-runner/src/pi-index.ts | 将工具及说明接入 runTurn，并在结束时释放 |
| SKILL.md | 独立 CLI 演示的操作说明 |
| references/review-rubric.md | 诊断报告验收参考 |

Runtime 演示由 incident-tools.ts 注入工具说明；本轮验证未单独证明 SKILL.md 的自动加载与执行。

## 规则与边界

- 配置默认关闭，仅在 Host 工作区显式启用；支持的 case_id 为 release-regression、upstream-timeout、insufficient-evidence。容器模式尚未接入此演示。
- 每次 runTurn 固定 case、service、namespace 和时间范围，只允许范围内的时间子区间，采用 [start, end)。
- 所有请求（包括拒绝）共用默认 12 次尝试预算；这是该工具的请求预算，不等于整个 Agent 的 max_iter。
- 同一规范化查询连续两次返回 unavailable 或 error 后，后续相同查询被熔断；empty 不计为失败。计数在本次运行内有效，未实现跨重启恢复。
- 权限决定先同步写入 JSONL；写入失败时不执行查询。只有 allow 而没有结果的记录不能证明查询完成。
- Pi 参数校验可能先于 Harness 拒绝请求，这类请求不会进入此审计入口。
- 约束只覆盖新增查询工具，其他通用工具仍开放。直接调用 CLI 不经过 Harness；当前不是全局安全沙箱。
- 尚未接入真实监控、人工审批执行或模型批量评测，无生产 MTTR 改善率、准确率或通用安全保证。

保留上游 Miniclaw Runtime 与许可证。本演示及集成由 Codex 辅助编写，项目维护者负责运行、理解和后续改造。
