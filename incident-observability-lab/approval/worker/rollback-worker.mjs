export async function runRollback({ call, boundary }) {
  const observed = await call('/release/observe', {});
  if (observed.status !== 'observed')
    throw new Error(
      'Release observation denied: ' + (observed.code ?? 'unknown'),
    );
  const proposal = await call('/release/propose', {
    action: 'rollback_deployment',
    reason:
      'Local release experiment: previous template measured HTTP 200; current regression-v2 template measured three HTTP 503 responses with its Pod not Ready. Propose restoring the bound healthy template, pending human review.',
  });
  if (proposal.status !== 'pending_human_approval')
    throw new Error(
      'Rollback proposal denied: ' + (proposal.code ?? 'unknown'),
    );
  console.log(
    JSON.stringify({
      mode: 'isolated_release_rollback_smoke_test',
      llm_called: false,
      boundary,
      observed,
      proposal,
    }),
  );
}
