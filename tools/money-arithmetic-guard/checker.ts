import ts from 'typescript';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly operator: string;
  readonly text: string;
}

const MULTIPLICATIVE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
]);

/**
 * True if `type` is (or, for a union, includes) the branded `Paisa` type —
 * detected structurally by the `__brand: 'Paisa'` property, which survives
 * even when TypeScript widens away the `Paisa` type alias name.
 */
export function isPaisaBrandedType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) {
    return type.types.some((t) => isPaisaBrandedType(t, checker));
  }
  const brandProperty = type.getProperty('__brand');
  if (!brandProperty) return false;
  const declaration = brandProperty.valueDeclaration ?? brandProperty.declarations?.[0];
  if (!declaration) return false;
  const brandType = checker.getTypeOfSymbolAtLocation(brandProperty, declaration);
  return checker.typeToString(brandType) === '"Paisa"';
}

/**
 * Walk every source file in `program` (skipping declaration files and
 * anything whose path matches `isExcluded`) for a `*` or `/` (including
 * `*=` / `/=`) binary expression where either operand's type is the
 * branded `Paisa` money type, and report each as a `Violation`.
 */
export function findViolations(
  program: ts.Program,
  options: { isExcluded: (fileName: string) => boolean },
): Violation[] {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    if (options.isExcluded(sourceFile.fileName)) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && MULTIPLICATIVE_OPERATORS.has(node.operatorToken.kind)) {
        const leftType = checker.getTypeAtLocation(node.left);
        const rightType = checker.getTypeAtLocation(node.right);
        if (isPaisaBrandedType(leftType, checker) || isPaisaBrandedType(rightType, checker)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            operator: node.operatorToken.getText(sourceFile),
            text: node.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

export function createProgramForFiles(files: readonly string[], extraOptions?: ts.CompilerOptions): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    noEmit: true,
    ...extraOptions,
  };
  return ts.createProgram({ rootNames: [...files], options: compilerOptions });
}
