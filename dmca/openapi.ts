const ADMIN_SECURITY = [{ adminBearer: [] }] as const;

/** 建立營運者 DMCA 端點的自架 OpenAPI 文件。 */
export function dmcaOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Open4WD DMCA API',
      version: '1.0.0',
      description:
        '獨立 provider 的公開申訴流程、PeerId 驗簽收件匣與受保護管理面。營運者自行負責部署層存取控制；管理 API 仍必須提供 Bearer DMCA_ADMIN_TOKEN。',
    },
    tags: [{ name: 'Public' }, { name: 'Admin' }],
    paths: {
      '/api/dmca/notice': {
        post: {
          tags: ['Public'],
          summary: '提交 notice',
          responses: { '200': { description: '受理' } },
        },
      },
      '/api/dmca/notice/{id}': {
        get: {
          tags: ['Public'],
          summary: '確認信箱或查詢公開狀態',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'token', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: '狀態' }, '404': { description: '不存在' } },
        },
      },
      '/api/dmca/counter-notice': {
        post: {
          tags: ['Public'],
          summary: '提交 counter-notice',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CounterNoticeSubmissionV1' },
              },
            },
          },
          responses: { '200': { description: '受理' } },
        },
      },
      '/api/dmca/inbox': {
        post: {
          tags: ['Public'],
          summary: '以 requester PeerId 簽章查詢 provider-signed 最小案件通知',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SignedInboxRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'provider 簽章的最小收件匣；不含通知或反通知個資',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SignedInboxResponse' },
                },
              },
            },
            '401': { description: '簽章、requester 綁定、freshness 或 nonce 驗證失敗' },
            '413': { description: 'payload 超過 64 KiB' },
            '429': { description: '速率限制' },
          },
        },
      },
      '/api/dmca/transparency': {
        get: {
          tags: ['Public'],
          summary: '透明度摘要',
          responses: { '200': { description: '摘要' } },
        },
      },
      '/api/dmca/admin/notices': {
        get: {
          tags: ['Admin'],
          summary: '列出安全摘要',
          security: ADMIN_SECURITY,
          parameters: [
            { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/Status' } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
          ],
          responses: {
            '200': { description: '分頁摘要' },
            '401': { description: '缺少 Token' },
            '403': { description: 'Token 錯誤' },
          },
        },
      },
      '/api/dmca/admin/notices/{id}': {
        get: {
          tags: ['Admin'],
          summary: '取得完整案卷 DTO（不含確認 token）',
          security: ADMIN_SECURITY,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '案卷' }, '404': { description: '不存在' } },
        },
      },
      '/api/dmca/admin/notice/{id}/decision': {
        post: {
          tags: ['Admin'],
          summary: '依狀態矩陣裁決；操作者由受信任部署設定注入',
          security: ADMIN_SECURITY,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['action', 'reason'],
                  properties: {
                    action: {
                      type: 'string',
                      enum: ['take_down', 'reject', 'restore', 'hold', 'release_hold'],
                    },
                    reason: { type: 'string', minLength: 1, maxLength: 2000 },
                    evidence: {
                      type: 'object',
                      additionalProperties: false,
                      description:
                        'action=hold 時必填；只接受美國聯邦法院或 Copyright Claims Board。',
                      required: ['proceeding', 'reference', 'receivedAt'],
                      properties: {
                        proceeding: {
                          type: 'string',
                          enum: ['us-federal-court', 'copyright-claims-board'],
                        },
                        reference: { type: 'string', minLength: 1, maxLength: 1000 },
                        receivedAt: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: '裁決後案卷' },
            '400': { description: '輸入錯誤' },
            '404': { description: '不存在' },
            '409': { description: '不允許的狀態轉移' },
          },
        },
      },
      '/api/dmca/admin/counter-notice/{id}/identity-decision': {
        post: {
          tags: ['Admin'],
          summary: '人工接受或拒絕待覆核的反通知身分',
          security: ADMIN_SECURITY,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['action', 'reason'],
                  properties: {
                    action: { type: 'string', enum: ['accept', 'reject'] },
                    reason: { type: 'string', minLength: 1, maxLength: 2000 },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: '覆核後案卷' },
            '400': { description: '輸入錯誤' },
            '404': { description: '不存在' },
            '409': { description: '不允許的狀態轉移' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'DMCA_ADMIN_TOKEN' },
      },
      schemas: {
        CounterNoticePayloadV1: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion',
            'uploaderName',
            'uploaderEmail',
            'uploaderPhone',
            'uploaderAddress',
            'originalNoticeId',
            'takenDownContent',
            'goodFaithMistakeOrMisidentification',
            'perjuryStatement',
            'federalDistrict',
            'acceptsServiceFromClaimant',
            'signature',
            'signatureDate',
            'submittedAt',
          ],
          properties: {
            schemaVersion: { const: 1 },
            uploaderName: { type: 'string', minLength: 1, maxLength: 200 },
            uploaderEmail: { type: 'string', minLength: 1, maxLength: 320, format: 'email' },
            uploaderPhone: { type: 'string', minLength: 1, maxLength: 100 },
            uploaderAddress: { type: 'string', minLength: 1, maxLength: 2000 },
            originalNoticeId: { type: 'string', minLength: 1, maxLength: 128 },
            takenDownContent: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['cid', 'url', 'description'],
                properties: {
                  cid: { type: 'string', minLength: 1, maxLength: 256 },
                  url: { type: 'string', minLength: 1, maxLength: 2048, format: 'uri' },
                  description: { type: 'string', minLength: 1, maxLength: 4000 },
                },
              },
            },
            goodFaithMistakeOrMisidentification: { const: true },
            perjuryStatement: { const: true },
            federalDistrict: { type: 'string', minLength: 1, maxLength: 500 },
            acceptsServiceFromClaimant: { const: true },
            signature: { type: 'string', minLength: 1, maxLength: 200 },
            signatureDate: { type: 'string', minLength: 1, maxLength: 32 },
            submittedAt: { type: 'integer', minimum: 0 },
          },
        },
        SignedCounterNoticeV1: {
          type: 'object',
          additionalProperties: false,
          required: ['payload', 'timestamp', 'nonceHex', 'signer', 'signatureHex'],
          properties: {
            payload: { $ref: '#/components/schemas/CounterNoticePayloadV1' },
            timestamp: { type: 'integer', minimum: 0 },
            nonceHex: { type: 'string', pattern: '^[0-9a-f]{32}$' },
            signer: { type: 'string', minLength: 1 },
            signatureHex: { type: 'string', pattern: '^[0-9a-f]{128}$' },
          },
        },
        CounterNoticeSubmissionV1: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['mode', 'signed'],
              properties: {
                mode: { const: 'signed-uploader' },
                signed: { $ref: '#/components/schemas/SignedCounterNoticeV1' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['mode', 'payload'],
              properties: {
                mode: { const: 'manual-review' },
                payload: { $ref: '#/components/schemas/CounterNoticePayloadV1' },
              },
            },
          ],
        },
        SignedInboxRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['payload', 'timestamp', 'nonceHex', 'signer', 'signatureHex'],
          properties: {
            payload: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'providerId', 'subjectPeerId'],
              properties: {
                type: { const: 'open4wd-provider-dmca-inbox-request' },
                providerId: { type: 'string' },
                subjectPeerId: { type: 'string' },
              },
            },
            timestamp: { type: 'integer' },
            nonceHex: { type: 'string', pattern: '^[0-9a-f]{32}$' },
            signer: { type: 'string' },
            signatureHex: { type: 'string', pattern: '^[0-9a-f]{128}$' },
          },
        },
        SignedInboxResponse: {
          type: 'object',
          additionalProperties: false,
          required: ['payload', 'timestamp', 'nonceHex', 'signer', 'signatureHex'],
          properties: {
            payload: {
              type: 'object',
              description:
                'providerId、subjectPeerId、generatedAt 與最小案件 entries；不含表單 payload 或聯絡資料。',
            },
            timestamp: { type: 'integer' },
            nonceHex: { type: 'string', pattern: '^[0-9a-f]{32}$' },
            signer: { type: 'string' },
            signatureHex: { type: 'string', pattern: '^[0-9a-f]{128}$' },
          },
        },
        Status: {
          type: 'string',
          enum: [
            'pending-email-confirm',
            'pending-identity-review',
            'received',
            'taken_down',
            'rejected_by_admin',
            'restored_after_counter',
          ],
        },
      },
    },
  } as const;
}
