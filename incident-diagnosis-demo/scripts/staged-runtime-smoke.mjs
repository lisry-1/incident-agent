import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIncidentTools } from '../../container/agent-runner/dist/incident-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/dist/runtime/pi/pi-tools.js';
import { PiRuntimeAdapter } from '../../container/agent-runner/dist/runtime/pi/pi-runtime.js';

const root = mkdtempSync(path.join(tmpdir(), 'incident-pi-stage-'));
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('Network disabled in smoke test.');
};
let bundle, session;
const checks = [];
const names = {
  probe: 'mcp__miniclaw__incident_probe',
  investigate: 'mcp__miniclaw__incident_investigate',
  timeline: 'mcp__miniclaw__incident_timeline',
};
try {
  writeFileSync(
    path.join(root, 'incident-demo.config.json'),
    JSON.stringify({ case_id: 'release-regression', workflow: 'staged' }),
  );
  bundle = await createIncidentTools(root, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, {
    namespace: 'mcp__miniclaw',
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    Object.values(names),
  );
  checks.push('分阶段模式不注册旧 incident_query 入口');
  let controller;
  session = await new PiRuntimeAdapter().createSession({
    cwd: root,
    sessionDir: path.join(root, 'sessions'),
    model: 'fixture-only-model',
    provider: {
      endpointKind: 'custom',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'fixture-only-not-a-credential',
    },
    systemPrompt: bundle.prompt,
    allowedTools: ['Bash', 'mcp__miniclaw__*'],
    customTools: tools,
    configureTools: (value) => {
      controller = value;
      bundle.configureTools(value);
    },
  });
  assert.ok(controller);
  assert.deepEqual(
    controller
      .getActiveToolNames()
      .filter((n) => n.startsWith('mcp__miniclaw__incident_')),
    [names.probe],
  );
  assert.ok(controller.getActiveToolNames().includes('bash'));
  checks.push(
    '真实 Pi Session 在首次 prompt 前仅开放探活领域工具，保留通用工具',
  );
  let id = 0;
  const call = async (name, args) => {
    const tool = tools.find((t) => t.name === name);
    const result = await tool.execute(
      `stage-${++id}`,
      await tool.prepareArguments(args),
      new AbortController().signal,
    );
    return JSON.parse(result.content.find((c) => c.type === 'text').text);
  };
  const args = {
    case: 'release-regression',
    source: 'metrics',
    service: 'checkout-api',
    namespace: 'demo',
    start: '2026-10-15T10:00:00Z',
    end: '2026-10-15T10:15:00Z',
  };
  assert.equal(
    (await call(names.investigate, { ...args, source: 'logs' })).code,
    'STAGE_DENIED',
  );
  checks.push('直接调用深层执行函数也被程序阻止，不能绕过隐藏工具');
  assert.equal((await call(names.probe, args)).stage, 'deep');
  assert.deepEqual(
    controller
      .getActiveToolNames()
      .filter((n) => n.startsWith('mcp__miniclaw__incident_'))
      .sort(),
    [names.investigate, names.timeline].sort(),
  );
  assert.ok(controller.getActiveToolNames().includes('bash'));
  checks.push('异常探活后实际 Pi 工具列表切换为深层查询和时间线');
  assert.equal((await call(names.probe, args)).code, 'STAGE_DENIED');
  assert.equal(
    (
      await call(names.investigate, {
        ...args,
        source: 'logs',
        namespace: 'production',
      })
    ).code,
    'SCOPE_DENIED',
  );
  checks.push('阶段切换后仍拒绝旧阶段调用及越界 namespace');
  for (const source of ['logs', 'deployments', 'pod_events', 'traces']) {
    assert.equal(
      (await call(names.investigate, { ...args, source })).result.status,
      'ok',
    );
  }
  const timeline = (await call(names.timeline, {})).result;
  assert.equal(timeline.events.length, 8);
  assert.equal(
    timeline.events.find((e) => e.evidence_id === 'REL-P1').timestamp,
    '2026-10-15T10:05:00.125Z',
  );
  checks.push('实际适配器返回八条合成证据的毫秒时间线和关联');
  const auditFile = path.join(
    root,
    'incident-audit',
    readdirSync(path.join(root, 'incident-audit'))[0],
  );
  const audit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(audit.filter((e) => e.type === 'stage_transition').length, 1);
  assert.equal(
    audit.filter((e) => e.type === 'permission' && e.decision === 'deny')
      .length,
    3,
  );
  assert.equal(audit.filter((e) => e.type === 'tool_result').length, 6);
  checks.push('同一审计文件记录阶段转换、三次拒绝和六次工具执行');
  bundle.close();
  await assert.rejects(() => call(names.timeline, {}), /closed/);
  checks.push('运行释放后不可继续查询或生成时间线');
  assert.equal(networkAttempts, 0);
  checks.push('未请求模型接口或其他 fetch 网络资源');
  console.log(
    JSON.stringify(
      {
        mode: 'staged_runtime_smoke_test',
        llm_called: false,
        data_mode: 'synthetic_fixture',
        checks_passed: checks.length,
        checks,
        note: 'Creates the real Pi Runtime session and invokes adapted tools directly. No model prompt or live monitoring integration is tested.',
      },
      null,
      2,
    ),
  );
} finally {
  session?.dispose();
  bundle?.close();
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
