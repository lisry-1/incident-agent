# 故障诊断项目 v2：查询工具的权限与失败控制

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

## 当前边界

这是独立工具入口的程序测试，输出 llm_called: false。尚未接入 Miniclaw Runtime 的工具分发，不能约束 Miniclaw 的其他 shell、文件和网络工具；直接调用旧 CLI 也不会经过此入口。下一步必须将实际 incident 工具调用接入此入口，才能在该调用链上执行这些规则。

没有实现 OS/容器沙箱、网络隔离、真实监控适配、人工审批执行、跨重启恢复或模型评测，没有准确率与耗时改善数字。拒绝重启不等于已实现审批系统，JSONL 落盘不等于已实现断点续跑。

Miniclaw Runtime、会话和工作区来自上游；本目录由 Codex 辅助编写，需要用户运行、理解并继续修改。参考基线为 e1ebc699ab96544a032eb09abd4fb0ee5e3a1251，本版未修改该底座。

当前验证链路：请求 → 参数/权限检查 → 查询或拒绝 → 记录。真实模型诊断留待获得可用模型额度后验证。
