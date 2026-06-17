import * as ts from "typescript";
import type { CodeSymbol, SymbolKind } from "./types.ts";

// ---------------------------------------------------------------------------
// TypeScript / JavaScript extractor (compiler API)
// ---------------------------------------------------------------------------

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1; // 1-based
}

function endLineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function printParams(params: ts.NodeArray<ts.ParameterDeclaration>, sf: ts.SourceFile): string {
  return params.map((p) => p.getText(sf)).join(", ");
}

function printTypeNode(t: ts.TypeNode | undefined, sf: ts.SourceFile): string {
  return t ? `: ${t.getText(sf)}` : "";
}

function extractTypeScriptSymbols(content: string, filePath: string): CodeSymbol[] {
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const symbols: CodeSymbol[] = [];
  let currentClassName: string | null = null;

  function visit(node: ts.Node): void {
    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const params = printParams(node.parameters, sf);
      const ret = printTypeNode(node.type, sf);
      const asyncKw = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ? "async "
        : "";
      const sig = truncate(`${asyncKw}function ${name}(${params})${ret}`);
      symbols.push({
        name,
        kind: "function",
        line: lineOf(sf, node.getStart(sf)),
        endLine: endLineOf(sf, node),
        signature: sig,
      });
    }

    // Class declarations
    else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      symbols.push({
        name,
        kind: "class",
        line: lineOf(sf, node.getStart(sf)),
        endLine: endLineOf(sf, node),
      });
      const prev = currentClassName;
      currentClassName = name;
      ts.forEachChild(node, visit);
      currentClassName = prev;
      return; // already visited children
    }

    // Method declarations
    else if (ts.isMethodDeclaration(node) && currentClassName) {
      const nameNode = node.name;
      const methodName = ts.isIdentifier(nameNode)
        ? nameNode.text
        : ts.isStringLiteral(nameNode)
          ? nameNode.text
          : nameNode.getText(sf);
      const qualName = `${currentClassName}.${methodName}`;
      const params = printParams(node.parameters, sf);
      const ret = printTypeNode(node.type, sf);
      const asyncKw = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ? "async "
        : "";
      const sig = truncate(`${asyncKw}${qualName}(${params})${ret}`);
      symbols.push({
        name: qualName,
        kind: "method",
        line: lineOf(sf, node.getStart(sf)),
        endLine: endLineOf(sf, node),
        signature: sig,
      });
    }

    // Interface declarations
    else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({
        name: node.name.text,
        kind: "interface",
        line: lineOf(sf, node.getStart(sf)),
        endLine: endLineOf(sf, node),
      });
    }

    // Type alias declarations
    else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({
        name: node.name.text,
        kind: "type",
        line: lineOf(sf, node.getStart(sf)),
        endLine: endLineOf(sf, node),
      });
    }

    // Variable statements (top-level only: no currentClassName context)
    else if (ts.isVariableStatement(node) && !currentClassName) {
      const isConst = node.declarationList.flags & ts.NodeFlags.Const;
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;

        // Arrow function → treat as "function"
        if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const fn = decl.initializer;
          const params =
            ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)
              ? printParams(fn.parameters, sf)
              : "";
          const ret =
            ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? printTypeNode(fn.type, sf) : "";
          const asyncKw = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
            ? "async "
            : "";
          const sig = truncate(`${asyncKw}const ${name} = (${params})${ret} =>`);
          symbols.push({
            name,
            kind: "function",
            line: lineOf(sf, node.getStart(sf)),
            endLine: endLineOf(sf, node),
            signature: sig,
          });
        }

        // Exported const (non-function)
        else if (isConst && isExported) {
          symbols.push({
            name,
            kind: "const",
            line: lineOf(sf, node.getStart(sf)),
            endLine: endLineOf(sf, node),
          });
        }
      }
    }

    // Export declarations (named exports, skip re-exports from node_modules)
    else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const moduleSpecifier = node.moduleSpecifier;

      // Skip re-exports from node_modules
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        const spec = moduleSpecifier.text;
        if (spec.includes("node_modules") || (!spec.startsWith(".") && !spec.startsWith("/"))) {
          ts.forEachChild(node, visit);
          return;
        }
      }

      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          symbols.push({
            name: el.name.text,
            kind: "export",
            line: lineOf(sf, node.getStart(sf)),
            endLine: endLineOf(sf, node),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return symbols;
}

// ---------------------------------------------------------------------------
// Regex-based extractor (Python, Go, Rust, etc.)
// ---------------------------------------------------------------------------

interface RegexPattern {
  pattern: RegExp;
  kind: SymbolKind;
  nameGroup: number;
}

const LANGUAGE_PATTERNS: Record<string, RegexPattern[]> = {
  python: [
    {
      pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m,
      kind: "function",
      nameGroup: 1,
    },
    {
      pattern: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/m,
      kind: "class",
      nameGroup: 1,
    },
  ],
  go: [
    {
      pattern: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/m,
      kind: "function",
      nameGroup: 1,
    },
  ],
  rust: [
    {
      pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/m,
      kind: "function",
      nameGroup: 1,
    },
    {
      pattern: /^(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/m,
      kind: "class",
      nameGroup: 1,
    },
    {
      pattern:
        /^(?:pub\s+)?impl(?:\s+[A-Za-z_][A-Za-z0-9_<>, ]*\s+for)?\s+([A-Za-z_][A-Za-z0-9_]*)/m,
      kind: "class",
      nameGroup: 1,
    },
    {
      pattern: /^(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/m,
      kind: "interface",
      nameGroup: 1,
    },
  ],
  ruby: [
    {
      pattern: /^(?:def\s+self\.)?def\s+([A-Za-z_][A-Za-z0-9_?!]*)/m,
      kind: "function",
      nameGroup: 1,
    },
    {
      pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/m,
      kind: "class",
      nameGroup: 1,
    },
  ],
  java: [
    {
      pattern:
        /^(?:public|private|protected|static|\s)+(?:[\w<>[\]]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m,
      kind: "function",
      nameGroup: 1,
    },
    {
      pattern: /^(?:public|private|protected|abstract|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)/m,
      kind: "class",
      nameGroup: 1,
    },
  ],
};

function extractRegexSymbols(content: string, language: string): CodeSymbol[] {
  const patterns = LANGUAGE_PATTERNS[language];
  if (!patterns) return [];

  const lines = content.split("\n");
  const symbols: CodeSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { pattern, kind, nameGroup } of patterns) {
      // Match against the single line (strip global flag for line-by-line)
      const singleLinePattern = new RegExp(pattern.source, "");
      const m = singleLinePattern.exec(line);
      if (m) {
        const name = m[nameGroup];
        if (!name) continue;
        symbols.push({
          name,
          kind,
          line: i + 1, // 1-based
          endLine: i + 1, // will fix up below
        });
      }
    }
  }

  // Fix up endLine: next symbol's line - 1, or EOF
  for (let i = 0; i < symbols.length; i++) {
    const next = symbols[i + 1];
    const sym = symbols[i];
    if (!sym) continue;
    sym.endLine = next ? next.line - 1 : lines.length;
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export function extractSymbols(filePath: string, content: string, language: string): CodeSymbol[] {
  if (language === "typescript" || language === "javascript") {
    return extractTypeScriptSymbols(content, filePath);
  }
  if (language === "unknown") {
    return [];
  }
  return extractRegexSymbols(content, language);
}
