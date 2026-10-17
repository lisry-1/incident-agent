# 本地可观测性实验：Prometheus 接入

本轮目标：启动真实 HTTP 服务与 Prometheus，把实际处理的请求计数和耗时经 HTTP 查询适配器取回。数据标记 live_lab：流量和故障由实验脚本生成，不是生产业务数据，也不是读取预写 fixture JSON。

## 当前覆盖范围

- 本地 checkout 服务实际处理请求，输出请求计数与延迟直方图。
- Prometheus 每 5 秒抓取指标，适配器通过 /api/v1/query_range 查询。
- 查询固定服务 checkout-api、namespace 标签 demo 和 PromQL 模板，限制 35 秒至 15 分钟的窗口、5 秒步长、请求超时、响应大小及返回数据范围。
- 读到 NaN、无样本、单项失败时，保留缺失与 partial 标记；不会补零假装健康。
- 本模块目前是独立数据源验证入口，尚未接入 Miniclaw 的分阶段工具。此前真实模型验证仍对应 synthetic_fixture。
- Loki、Jaeger、Kubernetes 接入以及审批执行在后续阶段。这里的 namespace 是指标标签，还不是 Kubernetes 命名空间。

本轮故障注入让 HTTP 请求返回 503，并引入可控处理延迟；没有真实数据库或连接池，不能称为复现了 DB_POOL_MAX 故障。直方图 p95 是估计值。

## 启动

前提：Docker Desktop WSL 集成可用，Node.js 24，已安装当前仓库 v4 更新。

从项目根目录执行：

```bash
docker compose -f incident-observability-lab/compose.yaml config --quiet
docker compose -f incident-observability-lab/compose.yaml up -d --build
node incident-observability-lab/lab-cli.mjs check
```

check 在 Prometheus 就绪且实际抓取 checkout 成功后返回 status=ready、scrape_target_up=1。它不生成业务请求，不代表健康/故障指标对比已通过。

入口：

- checkout 健康检查：http://localhost:18080/health
- Prometheus：http://localhost:19090

宿主机端口绑定 127.0.0.1；容器使用内部网络。两个容器配置的内存上限合计 640 MiB，Docker 自身另有开销。本配置隔离的是实验服务网络，不是 Miniclaw Agent 的权限沙箱。

镜像：Prometheus v3.13.4（官方页面 2026-10-17 所列 LTS），Python 3.14-slim。Python 标签会随补丁更新，完全复现时应保存镜像 digest：

```bash
docker compose -f incident-observability-lab/compose.yaml images
```

## 产生正常与故障数据

check 成功后执行：

```bash
node incident-observability-lab/lab-cli.mjs exercise
```

脚本按顺序：设置健康模式 → 约 45 秒正常请求 → 读取指标 → 设置故障模式 → 约 45 秒 503 请求 → 读取指标 → 恢复健康模式。该命令明确包含对本地实验服务的故障注入；不是只读诊断命令，没有注册为 Agent 工具。

结果包含 passed、healthy_5xx_ratio、fault_5xx_ratio、requests_generated、audit_file。只有实际验证健康阶段 5xx≤1%、故障阶段≥10%、两阶段 target_up=1 且请求速率>0，才输出 passed=true。

完整查询结果保存在本目录 runs/<run_id>.json，默认不进 Git。不调用模型，不消耗模型 API 额度。脚本失败时会尝试恢复健康；恢复请求也失败时会报错，不能视为已恢复。

单独只读查询最近两分钟：

```bash
node incident-observability-lab/lab-cli.mjs capture
```

无流量或刚启动时，速率和延迟可能没有可用样本，这不是故障修复的证据。

## 时间窗与权限契约

- 适配器构造时固定 scope，query 仅接收 service、namespace、start、end。调用者不能传任意 PromQL、URL 或命令。
- 仅允许本地 HTTP loopback endpoint；Endpoint 属于可信运行配置，不是模型工具参数。当前无认证，不能直接套用到远程生产服务。
- query_range 的 end 原本包含端点，适配器以 end−1ms 转换成 [start,end)。
- rate 使用 30 秒回看。为了不读出授权窗，实际评估从请求 start+30s 开始；响应显式给出 evaluation_window。
- 每项返回 query_coverage，记录 ok/empty/unavailable、NaN 等被省略样本与上游警告。整体 status=ok 只表示有证据；还必须检查 partial 和每条证据的 missing_metrics。
- 当前适配器本身不具备前一版 Harness 的运行预算、失败熔断和 JSONL 决策日志；这些需在下一步异步 Runtime 集成中接入，不将独立 CLI 验证计作已完成 Agent 接入。

## 验证与限制

开发环境通过：

```bash
node --test incident-observability-lab/tests/*.test.mjs
python3 -m unittest discover -s incident-observability-lab/tests -p 'test_*.py'
```

10 项 HTTP 适配器测试使用本地协议测试服务器；3 项应用测试通过真实本地 HTTP 请求检查正常/故障响应与计数。开发环境没有 Docker，不能据此宣称 Compose 或真实 Prometheus 容器已验证。用户本地 check 和 exercise 的输出才是本轮集成验收依据。

如启动失败：

```bash
docker compose -f incident-observability-lab/compose.yaml ps
docker compose -f incident-observability-lab/compose.yaml logs --tail=40
```

停止实验（保留指标卷）：

```bash
docker compose -f incident-observability-lab/compose.yaml down
```

## 官方接口依据

- [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/)
- [Prometheus 镜像安装](https://prometheus.io/docs/prometheus/latest/installation/)
- [Prometheus 版本列表](https://prometheus.io/download/)
- [Compose 启动依赖与健康检查](https://docs.docker.com/compose/how-tos/startup-order/)
