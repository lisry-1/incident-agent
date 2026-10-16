# 故障诊断项目 v3：接入 Miniclaw 的工具注册入口

v3 增加 Host 模式下的可选工具注册：工作区配置启用后，Pi 会获得 `mcp__miniclaw__incident_query` 工具，其执行函数经过 IncidentHarness。附带源码补丁和不调用模型的适配器测试。先完成这一节，后面的独立演示仍然保留。

## 安装 v3 注册补丁

适用基线：Miniclaw `e1ebc699ab96544a032eb09abd4fb0ee5e3a1251`，以及在此基础上仅添加本演示目录的本地分支。补丁修改 `container/agent-runner/src/pi-index.ts`，新增 `container/agent-runner/src/incident-tools.ts`。应用前有 Git 检查点，`git apply` 会检查上下文，不会强行覆盖不匹配的代码。提示无法应用时停止并保留报错，不要强制应用。

把 incident-diagnosis-demo-v3.zip 下载到 Windows Downloads，然后在项目根目录的 Ubuntu 终端依次运行：

```bash
cd ~/agent-projects/incident-agent
python3 -m zipfile -e /mnt/c/Users/ASUS/Downloads/incident-diagnosis-demo-v3.zip .
git apply incident-diagnosis-demo/integration/miniclaw-incident-tools.patch
npm --prefix container/agent-runner run build
node incident-diagnosis-demo/scripts/runtime-smoke.mjs
```

不要重复应用同一补丁。如果你修改过演示目录，请解压前备份。依赖使用此前 make install 已安装的 agent-runner 依赖，不增加依赖或修改 lockfile。

成功输出 `mode: runtime_adapter_smoke_test`、`checks_passed: 9`、`llm_called: false`。测试实际调用编译后的工具注册模块和上游 Pi 适配器，验证返回证据、越界拦截、重复失败熔断、落盘和释放。使用临时工作区，结束后清理；不会改变你的 Home 配置，不会访问模型 API。它还没有验证模型推理、Pi 会话完整生命周期或网页聊天。

## 工作区启用方式（完成上述测试后再做）

默认不注册这个工具。Host 工作区目录下必须有 `incident-demo.config.json`，内容仅含一个受支持的 case_id，例如：

```json
{"case_id":"release-regression"}
```

你的 Home 路径是 `data/groups/main/incident-demo.config.json`。该工作区产生的审计记录保存在 `data/groups/main/incident-audit/`。配置仅选择固定合成用例，不接受模块路径、审计路径或命令。启用后重启服务，发起新会话，让工具列表和提示词一起重新加载。其他工作区不自动启用，容器模式暂不支持。

注册后的查询参数仍为 case/source/service/namespace/start/end，允许的 source 是 metrics/logs/deployments。范围在每次 runTurn 创建工具时固定，计数在同一 runTurn 内共享，结束或出错时 finally 关闭记录文件。Pi 的参数准备阶段可能先拒绝不符合 schema 的请求，这些请求不会到达本工具的审计入口。

Miniclaw 的其他工具仍然开放，这只是领域查询入口的约束，不是全局只读模式、容器沙箱或完整安全门禁。本目录 SKILL.md 中的旧 CLI 流程是独立演示；验证受控调用时应使用注册的 incident_query，而不是直接从 bash 调用旧 CLI。

## v2 独立权限演示（已完成可跳过）

本版新增独立 IncidentHarness：执行前校验工具和参数；拒绝越界与修改操作；相同查询连续失败两次后停止重复执行；将权限决定和结果追加到 JSONL。全部使用模拟数据，无需 API Key 或 npm install。

## 现在只做这一步

把 incident-diagnosis-demo-v2.zip 下载到 Windows Downloads，然后在 Ubuntu（提示符是 lisry@...，不是 PowerShell 的 PS C:）执行：

```bash
cd ~/agent-projects/incident-agent
python3 -m zipfile -e /mnt/c/Users/ASUS/Downloads/incident-diagnosis-demo-v2.zip .
node incident-diagnosis-demo/scripts/incident-harness.mjs demo
```

会更新之前的 incident-diagnosis-demo 文件夹。若你自己修改过其中代码，请先复制备份再解压。Windows 用户目录或下载文件名若不同，请相应调整路径。

预期七步：

| 步骤 | 结果 | 实际查询是否执行 |
| --- | --- | --- |
| 正常指标查询 | ok | 是 |
| 越界查询 production | SCOPE_DENIED | 否 |
| 请求重启服务 | TOOL_NOT_ALLOWED | 否 |
| 缺失日志：第 1 次 | unavailable | 是 |
| 缺失日志：第 2 次 | unavailable | 是 |
| 缺失日志：第 3 次 | CIRCUIT_OPEN | 否 |
| 再次查询可用指标 | ok | 是 |

输出中的 audit_file 是你电脑上的记录文件。每次演示在 runs/ 下生成一个新文件；7 条权限决定、4 条实际查询结果，共 11 行。runs/ 已加入本目录的 .gitignore。

## 文件分工

| 文件 | 职责 |
| --- | --- |
| scripts/incident-cli.mjs | 查指标、日志、发布记录，校验参数并返回证据来源 |
| scripts/incident-harness.mjs | 权限检查、失败计数、调用预算、JSONL 记录 |
| fixtures/*.json | 发布回归、上游超时、证据不足三组人工样例 |
| tests/*.test.mjs | 查询与控制逻辑的程序测试 |
| SKILL.md | 后续给模型使用的领域操作流程 |
| references/review-rubric.md | 模型接入后的报告验收标准 |

## 已实现的规则

只注册 incident.query，不执行任意 shell 或业务修改命令。每次运行固定 case、service、namespace 和时间范围；拒绝额外参数，允许范围内的时间子区间，采用 [start, end)。先通过检查，再调用查询函数。

失败按规范化的完整查询参数计数，调整字段顺序不能绕过。unavailable 和 error 计为失败，empty 不计为失败。不同参数独立计数，但所有请求（包括被拒绝的）共同受到默认 12 次尝试的限制。新运行有独立计数，尚未实现跨重启恢复。

权限决定先同步写入 JSONL，再执行查询；写入失败会抛错，查询不会继续。查询结果也同步追加。如果此时进程崩溃，可能只有允许记录、没有结果；允许记录不代表查询已成功。

## 运行测试

```bash
node --test incident-diagnosis-demo/tests/*.test.mjs
```

原版证据查询演示仍可运行：

```bash
node incident-diagnosis-demo/scripts/incident-cli.mjs demo
```

## 独立演示的边界

下面的 guard 演示是独立工具入口测试，输出 llm_called: false。只有应用并启用上面的 v3 补丁后，注册的 incident_query 执行函数才会经过此入口；它仍不能约束 Miniclaw 的其他 shell、文件和网络工具，直接调用旧 CLI 也不会经过此入口。

没有实现 OS/容器沙箱、网络隔离、真实监控适配、人工审批执行、跨重启恢复或模型评测，没有准确率与耗时改善数字。拒绝重启不等于已实现审批系统，JSONL 落盘不等于已实现断点续跑。

Miniclaw Runtime、会话和工作区来自上游；本目录及 v3 注册补丁由 Codex 辅助编写，需要用户运行、理解并继续修改。参考基线为 e1ebc699ab96544a032eb09abd4fb0ee5e3a1251。v3 在其注册入口增加可选的领域工具，不替换上游 Runtime。

当前验证链路：请求 → 参数/权限检查 → 查询或拒绝 → 记录。真实模型诊断留待获得可用模型额度后验证。
