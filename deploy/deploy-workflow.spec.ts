import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('operator deploy workflow', () => {
  it('is dispatch-only, opt-in gated and SHA-pinned', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*push:/mu);
    expect(workflow).toContain("vars.DEPLOY_ENABLED == 'true'");
    for (const use of workflow.matchAll(/uses:\s*([^\s#]+)/gu))
      expect(use[1]).toMatch(/@[0-9a-f]{40}$/u);
  });

  it('fails closed, renders every public placeholder, uses Kubernetes secrets and rolls back', () => {
    for (const key of [
      'KUBE_CONFIG',
      'CLUSTER_SECRET',
      'LEDGER_DB_ADDRESS',
      'GENESIS_TIMESTAMP',
      'GOVERNANCE_SIGNERS',
      'AUTHORIZED_SIGNERS',
      'DOMAIN',
    ])
      expect(workflow).toContain(key);
    expect(workflow).toContain('kubectl create secret generic open4wd-pinning-secrets');
    expect(workflow).toContain('invalid CORS_ALLOWED_ORIGINS');
    expect(workflow).toContain("os.environ['LEDGER_DB_ADDRESS'], 'LEDGER_DB_ADDRESS'");
    expect(workflow).toContain("os.environ['GENESIS_TIMESTAMP'], 'GENESIS_TIMESTAMP'");
    expect(workflow).toContain('CLUSTER_SECRET must contain at least 32 characters');
    expect(workflow).toContain('kubectl wait --for=condition=Ready certificate/open4wd-pinning');
    expect(workflow).toContain('scripts/smoke.ts --strict');
    expect(workflow).toContain('waiting for ingress propagation');
    expect(workflow).toContain('kubectl rollout undo deployment/open4wd-pinning');
  });
});
