import { describe, expect, it } from 'vitest';
import { auditVendorImportClosure, collectRelativeVendorImports } from './vendor-closure';

describe('vendor import closure parser', () => {
  it('collects static, side-effect, dynamic, export and import type references', () => {
    const text = `
import './side-effect';
import { value } from './static';
export { other } from './exported';
type Imported = import('./typed').Imported;
const dynamic = import('./dynamic');
`;
    expect(collectRelativeVendorImports({ path: 'module/source.ts', text })).toEqual([
      './dynamic',
      './exported',
      './side-effect',
      './static',
      './typed',
    ]);
  });

  it('reports list omissions and root escapes', () => {
    expect(
      auditVendorImportClosure([
        {
          path: 'module/source.ts',
          text: "import './included'; import './missing'; import '../../outside';",
        },
        { path: 'module/included.ts', text: 'export const included = true;' },
      ]),
    ).toEqual([
      'module/source.ts -> ../../outside escapes vendor root',
      'module/source.ts -> ./missing is outside vendor-list.json',
    ]);
  });
});
