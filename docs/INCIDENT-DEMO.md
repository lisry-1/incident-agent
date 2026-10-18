# 复现与演示入口

先看 [验收记录](INCIDENT-ACCEPTANCE.md)，需要展示代码行为时再选择对应步骤。已经验收过的实际重启/回滚无需为查看交付文件重新执行。

## 1. 无模型、无 Docker 的 fixture 检查

在新 clone 的项目根目录准备 Node.js/npm，安装已有锁定依赖；首次运行 npm ci 会执行依赖安装脚本：

```bash
npm ci
npm --prefix container/agent-runner ci
npm --prefix container/agent-runner run build
```

只演示本地领域工具：

```bash
node incident-diagnosis-demo/scripts/incident-harness.mjs demo
node incident-diagnosis-demo/scripts/staged-runtime-smoke.mjs
node --test incident-eval/tests/*.test.mjs
```

应看到固定范围拒绝、重复失败熔断、真实 Pi Session 工具阶段切换及评测器离线检查。这里不调用模型，llm_called=false；fixture 是合成证据。

## 2. 四源实际观测

需要 Docker Desktop WSL2 集成及可下载镜像的网络。以下步骤会创建本地实验集群与资源；exercise-kubernetes 会注入 HTTP 503、生成流量并尝试恢复。

```bash
docker compose -f incident-observability-lab/compose.yaml up -d --build
bash incident-observability-lab/kubernetes/install-tools.sh
node incident-observability-lab/kubernetes/setup.mjs
node incident-observability-lab/lab-cli.mjs check-kubernetes
node incident-observability-lab/lab-cli.mjs exercise-kubernetes
```

预期输出 passed=true、RBAC 与同 Pod UID 检查通过、健康/故障 5xx 对比、日志/抽样 trace/Event 计数及 restored_healthy=true。具体数量随本次实际请求变化，不必等于旧回执。若 Docker Desktop 旧 bind mount 失效，setup 已使用仅重建 Prometheus 容器的方式刷新挂载，保留指标卷。

网页四源诊断与固定时间窗配置见 [Runtime](../incident-observability-lab/RUNTIME.md) 和 [Kubernetes](../incident-observability-lab/KUBERNETES.md)。Web 使用 npm run dev:all；已有服务监听 3000/5173 时不要重复启动。

## 3. 隔离诊断与人工批准重启

前一步已可用后运行：

```bash
node incident-observability-lab/approval/cli.mjs setup
node incident-observability-lab/approval/cli.mjs diagnose
```

这是包含故障注入的操作者命令；默认不请求模型。成功停在 pending_human_approval，故障模式暂时保留。展示隔离配置、四源证据、具体目标和摘要。要停止实验而不批准动作：

```bash
node incident-observability-lab/approval/cli.mjs restore
```

只有确实准备执行本地一次重启时，再按 [审批步骤](../incident-observability-lab/APPROVAL.md) 用本轮 proposal_id 审阅、交互批准和执行。不能复用 README/旧回执中的 UUID，也不要复制历史 APPROVE 字符串。

可选 --model 流程会消耗 API 额度，密钥只在当前终端设置。完整步骤见 APPROVAL.md。模型缺少证据或未产生提案时不能自动退回放宽边界的执行方式。

## 4. Deployment 配置回滚

这是同镜像不同启动配置的独立实验，不是四源诊断后自动选择回滚：

```bash
node incident-observability-lab/approval/release-cli.mjs setup
node incident-observability-lab/approval/release-cli.mjs exercise
```

setup 创建健康 Deployment/角色并测量 HTTP；exercise 发布故障配置并停在待审批。后续仅对本轮精确提案人工批准，细节见 [回滚](../incident-observability-lab/ROLLBACK.md)。不继续时：

```bash
node incident-observability-lab/approval/release-cli.mjs restore
```

成功判据是批准模板恢复、新 Pod Ready、三次 HTTP 200 和 verified 回执；API 请求成功或 revision 变化本身不够。审批和凭据有有效期，结果未知先检查回执，不能删除 consumed 后重试。

## 5. 评测结果展示

已有结果无需 API：

```bash
python3 - <<'PY'
import json
from pathlib import Path
d = json.loads(Path('docs/evidence/fixed-eval-v1.1-review.json').read_text())
print('原自动结果：', d['original_summary']['automated_passed'], '/ 8')
print('离线严格复核：', d['offline_summary']['passed'], '/ 8')
print('失败项：', d['offline_summary']['failed_cases'])
print('本次复核新增模型请求：', d['new_model_requests'])
PY
```

重新进行真实模型评测是可选动作，会消耗额度。参见 [评测运行器](../incident-eval/README.md)，新结果另存，不覆盖当前证据，不靠重复抽取一次成功来声称稳定。

## 讲解顺序

三分钟可展示：问题与开源基线 → probe/deep 与范围拒绝 → 一条 trace/log/pod_uid 关联 → 提案/人工签名/回执 → 固定评测保留的两个失败。每一步说明是 fixture、live_lab 还是历史归档，不用实时执行所有流程。

结束四源实验可停止 Compose（保留卷）：

```bash
docker compose -f incident-observability-lab/compose.yaml down
```

该命令不会删除 kind 集群或本地私有凭据；无需为交付删除已经验证的环境。
