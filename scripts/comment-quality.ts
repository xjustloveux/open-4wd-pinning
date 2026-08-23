import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

export type CommentQualityRule =
  | 'stale documentation reference'
  | 'work-in-progress marker'
  | 'dated change history'
  | 'module entry missing header'
  | 'exported API missing TSDoc'
  | 'public member missing TSDoc'
  | 'private declaration missing TSDoc';

export interface CommentQualityFinding {
  readonly file: string;
  readonly rule: CommentQualityRule;
  readonly line: number;
  readonly detail: string;
}

const DOCUMENT_REFERENCE =
  /(?:\b(?:spec|specs)\b(?:\s*(?:§|section)|[\\/])|[\w\p{Script=Han}-]+\.md\b|(?:程式架構|部署資訊|資安規範|程式參數|資料系統)\s*(?:§|第))/iu;
const WORK_IN_PROGRESS = /\b(?:TODO|FIXME|HACK|XXX)\b/u;
const DATED_HISTORY = /\b20\d{2}[-/]\d{2}[-/]\d{2}\b/u;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

const containsTsDoc = (text: string): boolean => /\/\*\*[\s\S]*?\*\//u.test(text);

const hasTsDoc = (node: ts.Node & { readonly name?: ts.Node }, source: ts.SourceFile): boolean => {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  const declarationPrefixEnd = node.name?.getStart(source) ?? node.getStart(source);
  if (decorators.length === 0) {
    return containsTsDoc(source.text.slice(node.getFullStart(), declarationPrefixEnd));
  }
  const firstDecorator = decorators.at(0);
  const lastDecorator = decorators.at(-1);
  return (
    (firstDecorator !== undefined &&
      containsTsDoc(source.text.slice(node.getFullStart(), firstDecorator.getStart(source)))) ||
    (lastDecorator !== undefined &&
      containsTsDoc(source.text.slice(lastDecorator.end, declarationPrefixEnd)))
  );
};

const nodeName = (node: ts.Node & { readonly name?: ts.Node }): string =>
  node.name?.getText() ?? ts.SyntaxKind[node.kind];

const statementNames = (statement: ts.Statement): string[] => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  return [];
};

const supportedExportStatement = (statement: ts.Statement): boolean =>
  ts.isClassDeclaration(statement) ||
  ts.isFunctionDeclaration(statement) ||
  ts.isInterfaceDeclaration(statement) ||
  ts.isTypeAliasDeclaration(statement) ||
  ts.isEnumDeclaration(statement) ||
  ts.isVariableStatement(statement);

/** 檢查單一第一方 TypeScript 來源，且不限制註解語言。 */
export function inspectCommentQuality(text: string, file: string): CommentQualityFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: CommentQualityFinding[] = [];
  const exportedNames = new Set<string>();
  const exportedClasses = new Set<ts.ClassLikeDeclaration>();
  const report = (rule: CommentQualityRule, node: ts.Node, detail = ''): void => {
    const location = (node as ts.NamedDeclaration).name ?? node;
    findings.push({
      file,
      rule,
      line: source.getLineAndCharacterOfPosition(location.getStart(source)).line + 1,
      detail,
    });
  };

  const normalized = file.replace(/\\/gu, '/');
  if (/(?:^|\/)index\.ts$/u.test(normalized) && !/^\s*\/\*\*/u.test(text)) {
    findings.push({ file, rule: 'module entry missing header', line: 1, detail: '' });
  }

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const body = scanner.getTokenText();
    const line = source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1;
    if (DOCUMENT_REFERENCE.test(body))
      findings.push({ file, rule: 'stale documentation reference', line, detail: body.trim() });
    if (WORK_IN_PROGRESS.test(body))
      findings.push({ file, rule: 'work-in-progress marker', line, detail: body.trim() });
    if (DATED_HISTORY.test(body))
      findings.push({ file, rule: 'dated change history', line, detail: body.trim() });
  }

  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedNames.add((element.propertyName ?? element.name).text);
      }
    }
  }

  const exportedStatements = source.statements.filter(
    (statement) =>
      supportedExportStatement(statement) &&
      (hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
        statementNames(statement).some((name) => exportedNames.has(name))),
  );
  for (const statement of exportedStatements) {
    if (ts.isClassDeclaration(statement)) exportedClasses.add(statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer !== undefined &&
          ts.isClassExpression(declaration.initializer)
        ) {
          exportedClasses.add(declaration.initializer);
        }
      }
    }
  }

  const inspectMembers = (declaration: ts.ClassLikeDeclaration): void => {
    const methodGroups = new Map<string, ts.MethodDeclaration[]>();
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      const isPrivate =
        hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
        ('name' in member && member.name !== undefined && ts.isPrivateIdentifier(member.name));
      const isProtected = hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
      const relevant =
        ts.isPropertyDeclaration(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member);
      if (!relevant) continue;

      const name = nodeName(member);
      if (!isPrivate && !exportedClasses.has(declaration)) continue;
      if (ts.isMethodDeclaration(member)) {
        const visibility = isPrivate ? 'private' : isProtected ? 'protected' : 'public';
        const key = `${visibility}:${hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
        const group = methodGroups.get(key) ?? [];
        group.push(member);
        methodGroups.set(key, group);
        continue;
      }
      if (hasTsDoc(member, source)) continue;
      if (isPrivate) report('private declaration missing TSDoc', member, name);
      else report('public member missing TSDoc', member, name);
    }
    for (const group of methodGroups.values()) {
      if (group.some((member) => hasTsDoc(member, source))) continue;
      const member = group[0];
      if (member === undefined) continue;
      const isPrivate =
        hasModifier(member, ts.SyntaxKind.PrivateKeyword) || ts.isPrivateIdentifier(member.name);
      report(
        isPrivate ? 'private declaration missing TSDoc' : 'public member missing TSDoc',
        member,
        nodeName(member),
      );
    }
  };

  const functionGroups = new Map<string, ts.FunctionDeclaration[]>();
  for (const statement of exportedStatements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = nodeName(statement);
    const group = functionGroups.get(name) ?? [];
    group.push(statement);
    functionGroups.set(name, group);
  }
  const inspectedFunctions = new Set<ts.FunctionDeclaration>();
  for (const statement of exportedStatements) {
    const name = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
          .map((declaration) => nodeName(declaration))
          .join(', ')
      : nodeName(statement);
    if (ts.isFunctionDeclaration(statement)) {
      if (inspectedFunctions.has(statement)) continue;
      const group = functionGroups.get(name) ?? [statement];
      group.forEach((declaration) => inspectedFunctions.add(declaration));
      if (!group.some((declaration) => hasTsDoc(declaration, source))) {
        report('exported API missing TSDoc', statement, name);
      }
      continue;
    }
    if (!hasTsDoc(statement, source)) report('exported API missing TSDoc', statement, name);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) inspectMembers(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings.sort(
    (left, right) => left.line - right.line || left.rule.localeCompare(right.rule),
  );
}

const PRODUCT_ROOTS = [
  'api',
  'app',
  'auth',
  'config',
  'core',
  'dmca',
  'metrics',
  'node',
  'pinning',
  'subscriber',
];

const collectProductFiles = (root: string): string[] => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'vendor' || name === 'generated') continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        extname(path) === '.ts' &&
        !path.endsWith('.d.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test-support.ts')
      ) {
        files.push(path);
      }
    }
  };
  for (const directory of PRODUCT_ROOTS) walk(join(root, directory));
  return files.sort();
};

export function runCommentQuality(root: string): CommentQualityFinding[] {
  return collectProductFiles(root).flatMap((file) =>
    inspectCommentQuality(readFileSync(file, 'utf8'), relative(root, file)),
  );
}

const invokedPath = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href;
if (import.meta.url === invokedPath) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const findings = runCommentQuality(root);
  for (const finding of findings) {
    console.error(
      `${finding.rule}: ${finding.file}:${finding.line}${finding.detail ? ` — ${finding.detail}` : ''}`,
    );
  }
  console.log(`comment-quality: ${findings.length} finding(s)`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}
