import { describe, expect, it } from 'vitest';
import { dmcaOpenApiDocument } from './openapi';

describe('DMCA OpenAPI document', () => {
  it('描述受保護管理面、Bearer token、分頁、詳情與 409 狀態轉移', () => {
    const document = dmcaOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.components.securitySchemes.adminBearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.paths['/api/dmca/admin/notices'].get.security).toEqual([{ adminBearer: [] }]);
    expect(document.paths['/api/dmca/admin/notices/{id}'].get).toBeDefined();
    expect(
      document.paths['/api/dmca/admin/notice/{id}/decision'].post.responses['409'],
    ).toBeDefined();
  });

  it('描述唯一的 authenticated signed inbox 契約，且不宣稱集中營運 provider', () => {
    const document = dmcaOpenApiDocument();
    expect(document.paths['/api/dmca/inbox'].post.requestBody).toBeDefined();
    expect(document.paths['/api/dmca/inbox'].post.responses['200']).toBeDefined();
    expect(document.info.description).not.toContain('集中營運部署');
    expect(JSON.stringify(document.paths['/api/dmca/inbox'])).not.toMatch(
      /claimantEmail|uploaderEmail|claimantAddress|uploaderAddress/,
    );
  });

  it('反通知 schema 明列兩種提交模式、完整法律欄位並拒絕未知鍵', () => {
    const document = dmcaOpenApiDocument();
    const request = document.paths['/api/dmca/counter-notice'].post.requestBody;
    expect(request).toBeDefined();
    const serialized = JSON.stringify({ request, schemas: document.components.schemas });
    expect(serialized).toContain('signed-uploader');
    expect(serialized).toContain('manual-review');
    expect(serialized).toContain('goodFaithMistakeOrMisidentification');
    expect(serialized).toContain('federalDistrict');
    expect(serialized).toContain('acceptsServiceFromClaimant');
    expect(serialized).not.toContain('uploaderPeerId');
    expect(serialized).toContain('additionalProperties');
  });
});
