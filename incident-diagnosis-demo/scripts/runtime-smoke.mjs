import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Import the real compiled Miniclaw adapter. No API client or model prompt is invoked.
const { createIncidentTools } = await import('../../container/agent-runner/dist/incident-tools.js');
const { adaptClaudeMcpToolsToPi } = await import('../../container/agent-runner/dist/runtime/pi/pi-tools.js');
const workspace = mkdtempSync(path.join(tmpdir(), 'miniclaw-incident-runtime-'));
let bundle;
const checks = [];
try {
  assert.equal((await createIncidentTools(workspace, true)).tools.length, 0);
  checks.push('工作区未启用时，不注册故障工具');
  writeFileSync(path.join(workspace, 'incident-demo.config.json'), JSON.stringify({ case_id: 'insufficient-evidence' }));
  assert.equal((await createIncidentTools(workspace, false)).tools.length, 0);
  checks.push('容器模式不误启用宿主机演示');
  bundle = await createIncidentTools(workspace, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, { namespace: 'mcp__miniclaw' });
  assert.deepEqual(tools.map((tool) => tool.name), ['mcp__miniclaw__incident_query']);
  checks.push('经实际 Pi 适配器注册查询工具');
  const tool = tools[0];
  const args = { case: 'insufficient-evidence', source: 'metrics', service: 'checkout-api',
    namespace: 'demo', start: '2026-10-15T10:00:00Z', end: '2026-10-15T10:15:00Z' };
  let callNumber = 0;
  const call = async (input) => {
    const prepared = await tool.prepareArguments(input);
    const result = await tool.execute(`smoke-${++callNumber}`, prepared, new AbortController().signal);
    return { response: result, event: JSON.parse(result.content.find((item) => item.type === 'text').text) };
  };
  assert.equal((await call(args)).event.result.status, 'ok');
  checks.push('Pi 工具执行函数可返回真实 fixture 证据');
  assert.equal((await call({ ...args, namespace: 'production' })).event.code, 'SCOPE_DENIED');
  checks.push('经 Pi 工具执行函数的越界请求被拦截');
  const missing = { ...args, source: 'logs' };
  for (let i = 0; i < 2; i++) assert.equal((await call(missing)).event.result.status, 'unavailable');
  const blocked = await call(missing);
  assert.equal(blocked.event.code, 'CIRCUIT_OPEN');
  assert.equal(blocked.event.tool_executed, false);
  assert.equal(blocked.response.details.isError, true);
  checks.push('经 Pi 工具执行函数的重复失败被熔断');
  assert.equal((await call(args)).event.result.status, 'ok');
  const audits = readFileSync(path.join(workspace, 'incident-audit',
    (await import('node:fs')).readdirSync(path.join(workspace, 'incident-audit'))[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audits.filter((entry) => entry.type === 'permission').length, 6);
  assert.equal(audits.filter((entry) => entry.type === 'tool_result').length, 4);
  checks.push('工作区 JSONL 保存 6 次请求、4 次实际执行');
  bundle.close();
  await assert.rejects(() => call(args), /closed/);
  checks.push('释放工具后不能继续执行');
  bundle = undefined;
  writeFileSync(path.join(workspace, 'incident-demo.config.json'), JSON.stringify({ case_id: '../../secret' }));
  await assert.rejects(() => createIncidentTools(workspace, true), /Invalid incident/);
  checks.push('拒绝未知或路径形式的 case 配置');
  console.log(JSON.stringify({ mode: 'runtime_adapter_smoke_test', llm_called: false,
    checks_passed: checks.length, checks,
    note: 'Invokes the real Pi tool adapter directly; no model inference or end-to-end chat was tested.' }, null, 2));
} finally {
  bundle?.close();
  rmSync(workspace, { recursive: true, force: true });
}
