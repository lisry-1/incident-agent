import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../container/agent-runner/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js';
import { nextToolContext, assistantDiagnostic } from '../approval/worker/model-state.mjs';

function response(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: message.stopReason, message };
    },
    result: async () => message,
  };
}
function assistant(content, stopReason = 'toolUse') {
  return { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic',
    model: 'offline-test', timestamp: Date.now(), stopReason, content };
}

test('real Pi running loop replaces its snapshot tools between probe, deep and proposal turns', async () => {
  let agent, calls = 0;
  const executed = [], visible = [];
  const names = ['incident_probe', 'incident_investigate', 'incident_propose'];
  const tools = names.map((name, index) => ({
    name, label: name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      executed.push(name);
      agent.state.tools = index < 2 ? [tools[index + 1]] : [];
      return { content: [{ type: 'text', text: 'ok' }], details: {},
        ...(index === 2 ? { terminate: true } : {}) };
    },
  }));
  agent = new Agent({
    initialState: { systemPrompt: 'Preserve scope and history.', tools: [tools[0]],
      model: { id: 'offline-test', provider: 'anthropic', api: 'anthropic-messages' } },
    prepareNextTurnWithContext: nextToolContext(() => agent.state.tools),
    shouldStopAfterTurn: () => calls >= 3,
    streamFn: (_model, context) => {
      const index = calls++;
      assert.equal(context.systemPrompt, 'Preserve scope and history.');
      assert.ok(context.messages.some((m) => m.role === 'user'));
      assert.deepEqual(context.tools.map((t) => t.name), [names[index]]);
      if (index) assert.ok(context.messages.some((m) => m.role === 'toolResult'));
      visible.push(context.tools.map((t) => t.name));
      return response(assistant([{ type: 'toolCall', id: `call-${index}`,
        name: names[index], arguments: {} }]));
    },
  });
  await agent.prompt('Run the staged offline test.');
  assert.equal(agent.state.errorMessage, undefined);
  assert.deepEqual(executed, names);
  assert.deepEqual(visible, names.map((name) => [name]));
});

test('model provider failures retain stop reason and message even when Pi prompt resolves', async () => {
  const final = assistant([], 'error');
  final.errorMessage = '400 fixed provider request rejected';
  const diagnostics = [];
  const agent = new Agent({
    initialState: { tools: [], model: { id: 'offline-test', provider: 'anthropic', api: 'anthropic-messages' } },
    streamFn: () => response(final),
  });
  agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant')
      diagnostics.push(assistantDiagnostic(event.message));
  });
  await agent.prompt('No real provider is called.');
  assert.equal(agent.state.errorMessage, final.errorMessage);
  assert.equal(diagnostics[0].stop_reason, 'error');
  assert.equal(diagnostics[0].error_message, final.errorMessage);
});
