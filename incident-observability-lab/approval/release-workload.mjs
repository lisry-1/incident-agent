import { RELEASE_IMAGE } from './rollback.mjs';
export function releaseWorkload(mode = 'healthy') {
  if (!['healthy', 'fault'].includes(mode))
    throw new Error('Unknown release mode.');
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'checkout-release',
      namespace: 'demo',
      labels: { app: 'incident-checkout-release' },
    },
    spec: {
      replicas: 1,
      revisionHistoryLimit: 5,
      progressDeadlineSeconds: 120,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: 'incident-checkout-release' } },
      template: {
        metadata: { labels: { app: 'incident-checkout-release' } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'checkout',
              image: RELEASE_IMAGE,
              imagePullPolicy: 'Never',
              ports: [{ containerPort: 8080 }],
              env: [
                { name: 'LAB_INITIAL_MODE', value: mode },
                {
                  name: 'LAB_RELEASE',
                  value: mode === 'healthy' ? 'stable-v1' : 'regression-v2',
                },
                {
                  name: 'POD_UID',
                  valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
                },
              ],
              readinessProbe: {
                httpGet: { path: '/ready', port: 8080 },
                initialDelaySeconds: 2,
                periodSeconds: 2,
                failureThreshold: 1,
              },
              resources: {
                requests: { cpu: '25m', memory: '24Mi' },
                limits: { cpu: '250m', memory: '96Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  };
}
export const releaseService = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'checkout-release', namespace: 'demo' },
  spec: {
    publishNotReadyAddresses: true,
    selector: { app: 'incident-checkout-release' },
    ports: [{ port: 8080, targetPort: 8080 }],
  },
};
