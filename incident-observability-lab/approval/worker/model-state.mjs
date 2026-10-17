// Pi snapshots tools at prompt start. Supply the current allowlist between turns
// while preserving the loop's own message history and system prompt.
export function nextToolContext(getTools) {
  return ({ context }) => ({
    context: { ...context, tools: getTools().slice() },
  });
}

export function assistantDiagnostic(message) {
  return {
    stop_reason: message.stopReason,
    ...(message.errorMessage ? { error_message: message.errorMessage } : {}),
    content: message.content,
  };
}
