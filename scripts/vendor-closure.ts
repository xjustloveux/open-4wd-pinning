import { posix } from 'node:path';
import ts from 'typescript';

export interface VendorClosureSource {
  readonly path: string;
  readonly text: string;
}

const candidatesFor = (sourcePath: string, specifier: string): string[] => {
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  const candidates = [base, `${base}.ts`, `${base}.json`, posix.join(base, 'index.ts')];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  return [...new Set(candidates)];
};

/** 解析所有靜態／side-effect／dynamic import 與 import type 的相對依賴。 */
export function collectRelativeVendorImports(source: VendorClosureSource): string[] {
  if (!source.path.endsWith('.ts')) return [];
  const file = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = new Set<string>();
  const add = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node) && node.text.startsWith('.'))
      imports.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...imports].sort();
}

/** 驗證清單形成完整、不可逸出 vendor root 的相對 import 閉包。 */
export function auditVendorImportClosure(sources: readonly VendorClosureSource[]): string[] {
  const listed = new Set(sources.map(({ path }) => path));
  const failures: string[] = [];
  for (const source of sources) {
    for (const specifier of collectRelativeVendorImports(source)) {
      const candidates = candidatesFor(source.path, specifier);
      if (candidates.some((candidate) => candidate.startsWith('../'))) {
        failures.push(`${source.path} -> ${specifier} escapes vendor root`);
      } else if (!candidates.some((candidate) => listed.has(candidate))) {
        failures.push(`${source.path} -> ${specifier} is outside vendor-list.json`);
      }
    }
  }
  return failures.sort();
}
