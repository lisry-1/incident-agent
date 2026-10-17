import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import {
  generateKeyPairSync,
  createHash,
  sign,
  verify,
  randomUUID,
} from 'node:crypto';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX32 = /^[a-f0-9]{32}$/;
export const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  fail('INVALID_ARGUMENTS', 'Expected plain JSON values.');
}
export const digest = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const keys = (v, names) => {
  if (
    !v ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Object.keys(v).sort().join(',') !== [...names].sort().join(',')
  )
    fail('INVALID_ARGUMENTS', 'Unexpected fields.');
};
const data = (domain, v) => Buffer.from(domain + '\0' + canonical(v));
function durable(file, value, flag = 'wx') {
  const fd = openSync(file, flag, 0o600);
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function checkTarget(t) {
  keys(t, [
    'cluster',
    'namespace',
    'pod',
    'pod_uid',
    'container',
    'instance_id',
    'restart_count',
  ]);
  if (
    t.cluster !== 'incident-lab' ||
    t.namespace !== 'demo' ||
    t.pod !== 'checkout-k8s' ||
    t.container !== 'checkout' ||
    !UUID.test(t.pod_uid) ||
    !HEX32.test(t.instance_id) ||
    !Number.isSafeInteger(t.restart_count) ||
    t.restart_count < 0
  )
    fail(
      'SCOPE_DENIED',
      'Only the pinned local checkout container is supported.',
    );
}
export function checkRollbackTarget(t) {
  keys(t, [
    'cluster',
    'namespace',
    'deployment',
    'deployment_uid',
    'generation',
    'current_revision',
    'current_template_digest',
    'stable_replicaset',
    'stable_replicaset_uid',
    'stable_revision',
    'stable_template_digest',
  ]);
  if (
    t.cluster !== 'incident-lab' ||
    t.namespace !== 'demo' ||
    t.deployment !== 'checkout-release' ||
    !UUID.test(t.deployment_uid) ||
    !UUID.test(t.stable_replicaset_uid) ||
    !/^checkout-release-[a-z0-9]{5,16}$/.test(t.stable_replicaset) ||
    ![t.generation, t.current_revision, t.stable_revision].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    t.stable_revision >= t.current_revision ||
    ![t.current_template_digest, t.stable_template_digest].every((s) =>
      /^[a-f0-9]{64}$/.test(s),
    ) ||
    t.current_template_digest === t.stable_template_digest
  )
    fail(
      'SCOPE_DENIED',
      'Only the bound previous revision of local checkout-release is supported.',
    );
}
function actionParameters(action, target) {
  if (action === 'restart_container') {
    checkTarget(target);
    return { signal: 'SIGTERM', pid: 1 };
  }
  if (action === 'rollback_deployment') {
    checkRollbackTarget(target);
    return {
      strategy: 'restore_pod_template',
      template_digest: target.stable_template_digest,
    };
  }
  fail('ACTION_DENIED', 'Unsupported local action.');
}
export class ApprovalStore {
  constructor(directory, { clock = () => Date.now() } = {}) {
    this.directory = directory;
    this.clock = clock;
    for (const dir of [
      '',
      'keys',
      'proposals',
      'approvals',
      'consumed',
      'receipts',
    ])
      mkdirSync(path.join(directory, dir), { recursive: true, mode: 0o700 });
  }
  initialize() {
    for (const role of ['proposer', 'approver']) {
      const file = path.join(this.directory, 'keys', role + '.json');
      if (!existsSync(file)) {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const pub = publicKey
          .export({ format: 'pem', type: 'spki' })
          .toString();
        durable(file, {
          private_key: privateKey
            .export({ format: 'pem', type: 'pkcs8' })
            .toString(),
          public_key: pub,
          key_id: digest(pub),
        });
      }
    }
    return {
      proposer_key_id: this.#key('proposer').key_id,
      approver_key_id: this.#key('approver').key_id,
    };
  }
  #key(role) {
    return JSON.parse(
      readFileSync(path.join(this.directory, 'keys', role + '.json'), 'utf8'),
    );
  }
  #file(kind, id) {
    if (!UUID.test(id ?? ''))
      fail('INVALID_ID', 'Use an issued proposal UUID.');
    return path.join(this.directory, kind, id + '.json');
  }
  #journal(type, fields) {
    durable(
      path.join(this.directory, 'journal.jsonl'),
      { type, recorded_at: new Date(this.clock()).toISOString(), ...fields },
      'a',
    );
  }
  create({ action, target, evidence_digest, evidence_run_id, scope, reason }) {
    const parameters = actionParameters(action, target);
    if (
      !/^[a-f0-9]{64}$/.test(evidence_digest) ||
      !UUID.test(evidence_run_id ?? '')
    )
      fail(
        'INVALID_EVIDENCE',
        'A bound evidence digest and run ID are required.',
      );
    keys(scope, ['service', 'namespace', 'start', 'end']);
    if (
      scope.service !== 'checkout-api' ||
      scope.namespace !== 'demo' ||
      !Number.isFinite(Date.parse(scope.start)) ||
      !Number.isFinite(Date.parse(scope.end)) ||
      Date.parse(scope.start) >= Date.parse(scope.end)
    )
      fail('INVALID_EVIDENCE', 'Invalid observed scope.');
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500)
      fail('INVALID_ARGUMENTS', 'Reason must contain 1–500 characters.');
    const now = this.clock(),
      key = this.#key('proposer');
    const proposal = {
      version: 1,
      proposal_id: randomUUID(),
      action,
      target: structuredClone(target),
      parameters,
      evidence_digest,
      evidence_run_id,
      scope: structuredClone(scope),
      reason,
      created_at: now,
      expires_at: now + 600000,
      proposer_key_id: key.key_id,
    };
    const envelope = {
      proposal,
      proposer_signature: sign(
        null,
        data('incident-proposal-v1', proposal),
        key.private_key,
      ).toString('base64'),
    };
    durable(this.#file('proposals', proposal.proposal_id), envelope);
    this.#journal('proposal_created', {
      proposal_id: proposal.proposal_id,
      proposal_digest: digest(proposal),
      action,
      target: proposal.target,
      evidence_digest,
      evidence_run_id,
    });
    return {
      status: 'pending_human_approval',
      proposal,
      proposal_digest: digest(proposal),
      requires_human_approval: true,
    };
  }
  read(id) {
    const envelope = JSON.parse(
      readFileSync(this.#file('proposals', id), 'utf8'),
    );
    keys(envelope, ['proposal', 'proposer_signature']);
    const p = envelope.proposal;
    keys(p, [
      'version',
      'proposal_id',
      'action',
      'target',
      'parameters',
      'evidence_digest',
      'evidence_run_id',
      'scope',
      'reason',
      'created_at',
      'expires_at',
      'proposer_key_id',
    ]);
    const key = this.#key('proposer');
    if (
      p.proposal_id !== id ||
      p.version !== 1 ||
      p.proposer_key_id !== key.key_id ||
      !verify(
        null,
        data('incident-proposal-v1', p),
        key.public_key,
        Buffer.from(envelope.proposer_signature, 'base64'),
      )
    )
      fail('PROPOSAL_TAMPERED', 'Proposal signature or identity is invalid.');
    if (
      canonical(p.parameters) !==
      canonical(actionParameters(p.action, p.target))
    )
      fail('ACTION_DENIED', 'Unsupported execution parameters.');
    if (
      !Number.isSafeInteger(p.created_at) ||
      !Number.isSafeInteger(p.expires_at) ||
      p.expires_at <= this.clock() ||
      p.created_at > this.clock() + 5000 ||
      p.expires_at - p.created_at > 600000
    )
      fail(
        'PROPOSAL_EXPIRED',
        'Proposal is expired or has an invalid lifetime.',
      );
    return p;
  }
  approve(id) {
    // Called only by the trusted interactive CLI; no broker or model route exposes it.
    const p = this.read(id),
      now = this.clock(),
      key = this.#key('approver');
    const approval = {
      version: 1,
      proposal_id: id,
      proposal_digest: digest(p),
      approved_at: now,
      expires_at: Math.min(p.expires_at, now + 120000),
      nonce: randomUUID(),
      approver_key_id: key.key_id,
    };
    const envelope = {
      approval,
      approval_signature: sign(
        null,
        data('incident-human-approval-v1', approval),
        key.private_key,
      ).toString('base64'),
    };
    try {
      durable(this.#file('approvals', id), envelope);
    } catch (e) {
      if (e.code === 'EEXIST')
        fail('ALREADY_APPROVED', 'This proposal already has a decision.');
      throw e;
    }
    this.#journal('human_approved', {
      proposal_id: id,
      proposal_digest: approval.proposal_digest,
      approver_key_id: key.key_id,
      expires_at: approval.expires_at,
    });
    return approval;
  }
  authorize(id) {
    const p = this.read(id),
      file = this.#file('approvals', id);
    if (!existsSync(file))
      fail('APPROVAL_REQUIRED', 'Human approval is required before execution.');
    const e = JSON.parse(readFileSync(file, 'utf8'));
    keys(e, ['approval', 'approval_signature']);
    const a = e.approval;
    keys(a, [
      'version',
      'proposal_id',
      'proposal_digest',
      'approved_at',
      'expires_at',
      'nonce',
      'approver_key_id',
    ]);
    const key = this.#key('approver');
    if (
      a.version !== 1 ||
      a.proposal_id !== id ||
      a.proposal_digest !== digest(p) ||
      a.approver_key_id !== key.key_id ||
      !UUID.test(a.nonce ?? '') ||
      !verify(
        null,
        data('incident-human-approval-v1', a),
        key.public_key,
        Buffer.from(e.approval_signature, 'base64'),
      )
    )
      fail(
        'APPROVAL_TAMPERED',
        'Approval signature or proposal binding is invalid.',
      );
    if (
      !Number.isSafeInteger(a.approved_at) ||
      !Number.isSafeInteger(a.expires_at) ||
      a.expires_at <= this.clock() ||
      a.approved_at < p.created_at ||
      a.approved_at > this.clock() + 5000 ||
      a.expires_at > p.expires_at ||
      a.expires_at - a.approved_at > 120000
    )
      fail('APPROVAL_EXPIRED', 'Human approval has expired.');
    return p;
  }
  async execute(id, executor) {
    const proposal = this.authorize(id);
    try {
      durable(this.#file('consumed', id), {
        proposal_id: id,
        proposal_digest: digest(proposal),
        reserved_at: this.clock(),
      });
    } catch (e) {
      if (e.code === 'EEXIST')
        fail(
          'REPLAY_DENIED',
          'Approval already consumed; inspect the receipt. Never retry an unknown outcome.',
        );
      throw e;
    }
    this.#journal('execution_reserved', {
      proposal_id: id,
      proposal_digest: digest(proposal),
    });
    let receipt;
    try {
      const result = await executor(proposal);
      receipt = {
        status: 'verified',
        proposal_id: id,
        proposal_digest: digest(proposal),
        completed_at: this.clock(),
        result,
      };
    } catch (e) {
      receipt = {
        status:
          e.code === 'PRECONDITION_FAILED'
            ? 'precondition_failed'
            : 'execution_unknown_or_failed',
        proposal_id: id,
        completed_at: this.clock(),
        error: {
          code: e.code ?? 'EXECUTOR_FAILED',
          message:
            'Execution did not verify successfully. Approval remains consumed; inspect current state before making a new proposal.',
        },
      };
    }
    durable(this.#file('receipts', id), receipt);
    this.#journal('execution_finished', receipt);
    return receipt;
  }
}
