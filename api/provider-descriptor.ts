import { Protocol } from '../core';

/** 表示營運者是否已聲明完成法定代理人登記。 */
export type DesignatedAgentRegistration = 'not-declared' | 'registered';

const {
  UGC_CONTENT_PROFILE_ID,
  UGC_CONTENT_ROOT_CODECS,
  UGC_CONTENT_MULTIHASH,
  UGC_CHUNK_BYTES,
  UGC_LOGICAL_MAX_BYTES,
  UGC_MAX_BLOCKS,
} = Protocol.ugc;

/** 列出供應者描述檔公開的營運者政策頁面。 */
export interface ProviderPolicyUrls {
  readonly ugc?: string;
  readonly legal?: string;
  readonly privacy?: string;
  readonly retention?: string;
}

/** 提供建立供應者描述檔所需的營運能力與聲明。 */
export interface ProviderDescriptorInput {
  readonly providerId: string;
  readonly ugcReadEnabled: boolean;
  readonly ugcWriteEnabled: boolean;
  readonly legalNoticeEnabled: boolean;
  readonly counterNoticeEnabled: boolean;
  readonly transparencyEnabled: boolean;
  readonly designatedAgentRegistration: DesignatedAgentRegistration;
  readonly policies?: ProviderPolicyUrls;
}

/** 定義 Pinning 供應者提供的穩定公開能力文件。 */
export interface ProviderDescriptorBody {
  readonly schema_version: 1;
  readonly provider_id: string;
  readonly capabilities: {
    readonly ugc_read: {
      readonly enabled: boolean;
      readonly content_profile: {
        readonly id: typeof UGC_CONTENT_PROFILE_ID;
        readonly root_codecs: typeof UGC_CONTENT_ROOT_CODECS;
        readonly multihash: typeof UGC_CONTENT_MULTIHASH;
        readonly chunk_bytes: typeof UGC_CHUNK_BYTES;
        readonly max_logical_bytes: typeof UGC_LOGICAL_MAX_BYTES;
        readonly max_blocks: typeof UGC_MAX_BLOCKS;
      };
      readonly retrieval: {
        readonly root_scoped_block_api: true;
        readonly path_template: '/api/ugc/{rootCid}/blocks/{blockCid}';
        readonly car_v1: false;
        readonly cors: 'operator-allowlist';
      };
    };
    readonly ugc_write: {
      readonly enabled: boolean;
      readonly authorization: 'operator-policy';
    };
    readonly legal_notice: { readonly enabled: boolean };
    readonly counter_notice: { readonly enabled: boolean };
    readonly transparency: { readonly enabled: boolean };
  };
  readonly declarations: {
    readonly designated_agent_registration: DesignatedAgentRegistration;
    readonly safe_harbor_eligibility: 'not-asserted';
  };
  readonly policies: ProviderPolicyUrls;
}

const POLICY_KEYS = new Set(['ugc', 'legal', 'privacy', 'retention']);

function validatePolicies(value: ProviderPolicyUrls): ProviderPolicyUrls {
  if (Object.keys(value).some((key) => !POLICY_KEYS.has(key))) {
    throw new TypeError('provider policies contain an unknown key');
  }
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2_048) {
      throw new TypeError('provider policy URL must be a bounded string');
    }
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new TypeError('provider policy URL must be credential-free HTTPS without query/hash');
    }
    result[key] = url.toString();
  }
  return result;
}

/** Builds a provider-owned capability declaration without inferring legal eligibility. */
export function makeProviderDescriptor(input: ProviderDescriptorInput): ProviderDescriptorBody {
  return {
    schema_version: 1,
    provider_id: input.providerId,
    capabilities: {
      ugc_read: {
        enabled: input.ugcReadEnabled,
        content_profile: {
          id: UGC_CONTENT_PROFILE_ID,
          root_codecs: UGC_CONTENT_ROOT_CODECS,
          multihash: UGC_CONTENT_MULTIHASH,
          chunk_bytes: UGC_CHUNK_BYTES,
          max_logical_bytes: UGC_LOGICAL_MAX_BYTES,
          max_blocks: UGC_MAX_BLOCKS,
        },
        retrieval: {
          root_scoped_block_api: true,
          path_template: '/api/ugc/{rootCid}/blocks/{blockCid}',
          car_v1: false,
          cors: 'operator-allowlist',
        },
      },
      ugc_write: { enabled: input.ugcWriteEnabled, authorization: 'operator-policy' },
      legal_notice: { enabled: input.legalNoticeEnabled },
      counter_notice: { enabled: input.counterNoticeEnabled },
      transparency: { enabled: input.transparencyEnabled },
    },
    declarations: {
      designated_agent_registration: input.designatedAgentRegistration,
      safe_harbor_eligibility: 'not-asserted',
    },
    policies: validatePolicies(input.policies ?? {}),
  };
}
