import { describe, expect, it } from 'vitest';
import { authorize, type AuthConfig, type AuthDeps } from './authorize';

const noReputation: AuthDeps['reputationOf'] = () => undefined;
const notInfringer: AuthDeps['isRepeatInfringer'] = () => false;

describe('authorize', () => {
  it('白名單命中＝放行', () => {
    const cfg: AuthConfig = { authorizedSigners: ['peerA'] };
    const deps: AuthDeps = { reputationOf: noReputation, isRepeatInfringer: notInfringer };
    expect(authorize('peerA', 'pinning-pin', cfg, deps)).toEqual({ allowed: true });
  });

  it('信譽達閾值＝放行（700 ≥ 650）', () => {
    const cfg: AuthConfig = { authorizedSigners: [], reputationThreshold: 650 };
    const deps: AuthDeps = { reputationOf: () => 700, isRepeatInfringer: notInfringer };
    expect(authorize('peerB', 'pinning-pin', cfg, deps)).toEqual({ allowed: true });
  });

  it('信譽低於閾值仍拒 NOT_AUTHORIZED', () => {
    const cfg: AuthConfig = { authorizedSigners: [], reputationThreshold: 650 };
    const deps: AuthDeps = { reputationOf: () => 600, isRepeatInfringer: notInfringer };
    expect(authorize('peerB', 'pinning-pin', cfg, deps)).toEqual({
      allowed: false,
      code: 'NOT_AUTHORIZED',
    });
  });

  it('白名單與信譽門檻皆空／查無資料＝拒 NOT_AUTHORIZED', () => {
    const cfg: AuthConfig = { authorizedSigners: [] };
    const deps: AuthDeps = { reputationOf: noReputation, isRepeatInfringer: notInfringer };
    expect(authorize('peerC', 'pinning-pin', cfg, deps)).toEqual({
      allowed: false,
      code: 'NOT_AUTHORIZED',
    });
  });

  it('repeat-infringer：pin 拒 REPEAT_INFRINGER，unpin 放行（自清永遠可行）', () => {
    const cfg: AuthConfig = { authorizedSigners: ['peerD'] };
    const deps: AuthDeps = { reputationOf: noReputation, isRepeatInfringer: () => true };
    expect(authorize('peerD', 'pinning-pin', cfg, deps)).toEqual({
      allowed: false,
      code: 'REPEAT_INFRINGER',
    });
    expect(authorize('peerD', 'pinning-unpin', cfg, deps)).toEqual({ allowed: true });
  });
});
