import { describe, expect, it } from 'vitest';
import { makeProviderDescriptor } from './provider-descriptor';

describe('provider descriptor', () => {
  it('keeps UGC capabilities enabled when the standard DMCA workflow is disabled', () => {
    expect(
      makeProviderDescriptor({
        providerId: '12D3KooWprovider',
        ugcReadEnabled: true,
        ugcWriteEnabled: true,
        legalNoticeEnabled: false,
        counterNoticeEnabled: false,
        transparencyEnabled: false,
        designatedAgentRegistration: 'not-declared',
      }),
    ).toEqual({
      schema_version: 1,
      provider_id: '12D3KooWprovider',
      capabilities: {
        ugc_read: {
          enabled: true,
          content_profile: {
            id: 'open4wd-unixfs-1m-balanced-v1',
            root_codecs: ['raw', 'dag-pb'],
            multihash: 'sha2-256',
            chunk_bytes: 1_048_576,
            max_logical_bytes: 83_886_080,
            max_blocks: 81,
          },
          retrieval: {
            root_scoped_block_api: true,
            path_template: '/api/ugc/{rootCid}/blocks/{blockCid}',
            car_v1: false,
            cors: 'operator-allowlist',
          },
        },
        ugc_write: { enabled: true, authorization: 'operator-policy' },
        legal_notice: { enabled: false },
        counter_notice: { enabled: false },
        transparency: { enabled: false },
      },
      declarations: {
        designated_agent_registration: 'not-declared',
        safe_harbor_eligibility: 'not-asserted',
      },
      policies: {},
    });
  });

  it('declares every capability independently and never infers safe-harbor eligibility', () => {
    const descriptor = makeProviderDescriptor({
      providerId: '12D3KooWprovider',
      ugcReadEnabled: false,
      ugcWriteEnabled: true,
      legalNoticeEnabled: true,
      counterNoticeEnabled: true,
      transparencyEnabled: false,
      designatedAgentRegistration: 'registered',
      policies: {
        ugc: 'https://pin.example/policies/ugc',
        legal: 'https://pin.example/policies/legal',
        privacy: 'https://pin.example/policies/privacy',
        retention: 'https://pin.example/policies/retention',
      },
    });

    expect(descriptor.capabilities.ugc_read.enabled).toBe(false);
    expect(descriptor.capabilities.ugc_write.enabled).toBe(true);
    expect(descriptor.capabilities.legal_notice.enabled).toBe(true);
    expect(descriptor.capabilities.counter_notice.enabled).toBe(true);
    expect(descriptor.capabilities.transparency.enabled).toBe(false);
    expect(descriptor.declarations.safe_harbor_eligibility).toBe('not-asserted');
    expect(descriptor.policies).toEqual({
      ugc: 'https://pin.example/policies/ugc',
      legal: 'https://pin.example/policies/legal',
      privacy: 'https://pin.example/policies/privacy',
      retention: 'https://pin.example/policies/retention',
    });
  });

  it.each([
    'http://pin.example/legal',
    'https://user:pass@pin.example/legal',
    'https://pin.example/legal?token=secret',
    'https://pin.example/legal#section',
  ])('rejects unsafe policy URL %s', (legal) => {
    expect(() =>
      makeProviderDescriptor({
        providerId: '12D3KooWprovider',
        ugcReadEnabled: true,
        ugcWriteEnabled: true,
        legalNoticeEnabled: true,
        counterNoticeEnabled: true,
        transparencyEnabled: true,
        designatedAgentRegistration: 'not-declared',
        policies: { legal },
      }),
    ).toThrow(TypeError);
  });
});
