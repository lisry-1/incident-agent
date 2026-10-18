// Fixed, non-streaming provider transport used by the real Pi Agent loop.
// No SDK retry policy, endpoint overrides, arbitrary URLs or live tool requests.
export const MODEL = 'deepseek-flash';
const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';

export function requestBody(context) {
  const messages = [];
  for (const m of context.messages) {
    let role, content;
    if (m.role === 'toolResult') {
      role = 'user';
      content = [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
          is_error: !!m.isError,
        },
      ];
    } else if (m.role === 'user') {
      role = 'user';
      content =
        typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : m.content;
    } else if (m.role === 'assistant') {
      role = 'assistant';
      content = m.content
        .map((c) =>
          c.type === 'toolCall'
            ? { type: 'tool_use', id: c.id, name: c.name, input: c.arguments }
            : c,
        )
        .filter((c) => ['text', 'tool_use'].includes(c.type));
    } else throw new Error('UNSUPPORTED_MESSAGE');
    if (messages.at(-1)?.role === role)
      messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  return {
    model: MODEL,
    max_tokens: 2048,
    temperature: 0,
    thinking: { type: 'disabled' },
    system: context.systemPrompt,
    messages,
    ...(context.tools.length
      ? {
          tools: context.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  };
}

export async function providerRequest(body, { apiKey, signal }) {
  const wire = JSON.stringify(body);
  if (Buffer.byteLength(wire) > 256 * 1024)
    throw new Error('REQUEST_TOO_LARGE');
  const timeout = AbortSignal.timeout(45000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: wire,
    });
  } catch {
    throw new Error(
      combined.aborted ? 'MODEL_TIMEOUT_OR_ABORT' : 'MODEL_NETWORK_ERROR',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`MODEL_HTTP_${response.status}`);
  }
  let bytes = 0;
  const chunks = [];
  try {
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('MODEL_RESPONSE_INVALID_OR_INTERRUPTED');
  }
}

export function piMessage(raw) {
  if (
    !raw ||
    !Array.isArray(raw.content) ||
    !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(
      raw.stop_reason,
    )
  )
    throw new Error('MODEL_RESPONSE_INVALID');
  const content = raw.content.map((c) => {
    if (c.type === 'text' && typeof c.text === 'string')
      return { type: 'text', text: c.text };
    if (
      c.type === 'tool_use' &&
      typeof c.id === 'string' &&
      typeof c.name === 'string' &&
      c.input &&
      typeof c.input === 'object'
    )
      return { type: 'toolCall', id: c.id, name: c.name, arguments: c.input };
    throw new Error('MODEL_CONTENT_INVALID');
  });
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: MODEL,
    timestamp: Date.now(),
    content,
    stopReason:
      raw.stop_reason === 'tool_use'
        ? 'toolUse'
        : raw.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop',
    usage: {
      input: raw.usage?.input_tokens ?? 0,
      output: raw.usage?.output_tokens ?? 0,
      cacheRead: raw.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: raw.usage?.cache_creation_input_tokens ?? 0,
      totalTokens:
        (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

// Pi accepts an async event stream with result(). Provider data is obtained once.
export function transportStream(request, onRequest) {
  return (_model, context, options) => {
    const result = (async () => {
      onRequest();
      return piMessage(await request(requestBody(context), options));
    })();
    // Start awaiting inside the iterator too; result() always returns the same request.
    return {
      async *[Symbol.asyncIterator]() {
        const message = await result;
        yield { type: 'done', reason: message.stopReason, message };
      },
      result: () => result,
    };
  };
}
