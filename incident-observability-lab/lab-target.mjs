export function labJob(target = 'compose') {
  if (!['compose', 'kubernetes'].includes(target))
    throw new Error('Unknown trusted lab target.');
  return target === 'kubernetes' ? 'checkout-k8s-lab' : 'checkout-lab';
}
