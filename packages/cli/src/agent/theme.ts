import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { VIDEO_DIR, VIDEO_SRC } from "../paths";

/**
 * The target repository's Tailwind theme, made available to the renderer.
 *
 * The renderer runs stock Tailwind v4. Without the target's theme, custom utilities such as
 * `bg-brand-600`, `rounded-card` or shadcn's `text-muted-foreground` produce no CSS. This module
 * turns the target's tailwind.config (v3 style) into v4 `@theme` variables, and carries over the
 * CSS custom properties its globals define (`:root`, `.dark`) plus any v4 `@theme` blocks.
 * The config is read statically, never executed. Values are sanitized: a bad theme must
 * never break the render (the caller also retries without it).
 */

export const TARGET_THEME_FILE = path.join(VIDEO_SRC, "target-theme.css");
const PLACEHOLDER = "/* Target repository theme: written by @autodemo/cli before each render (empty by default). */\n";

type ThemeObject = Record<string, unknown>;
const NAMESPACES: Record<string, string> = {
  colors: "color",
  borderRadius: "radius",
  fontFamily: "font",
  fontSize: "text",
  boxShadow: "shadow",
  spacing: "spacing",
  fontWeight: "font-weight",
  letterSpacing: "tracking",
  lineHeight: "leading",
};

const safeKey = (k: string) => /^[A-Za-z0-9_-]+$/.test(k);
const safeValue = (v: string) => v.length < 300 && !/[;{}]|<\/?style/i.test(v);

function flatten(prefix: string, value: unknown, out: string[]): void {
  if (typeof value === "string" || typeof value === "number") {
    const v = String(value);
    // shadcn-style `sans: ["var(--font-sans)", ...]` would define the variable from itself
    if (safeValue(v) && !v.includes(`var(--${prefix})`)) out.push(`  --${prefix}: ${v};`);
    return;
  }
  if (Array.isArray(value)) {
    // fontFamily: ["Inter", "sans-serif"]; fontSize: ["0.875rem", { lineHeight: "1.25rem" }]
    if (prefix.startsWith("font-") && value.every((v) => typeof v === "string")) {
      const v = value.map((f: string) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(", ");
      if (safeValue(v) && !v.includes(`var(--${prefix})`)) out.push(`  --${prefix}: ${v};`);
    } else if (typeof value[0] === "string") flatten(prefix, value[0], out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as ThemeObject)) {
      if (!safeKey(k)) continue;
      flatten(k === "DEFAULT" ? prefix : `${prefix}-${k}`, v, out);
    }
  }
}

/** v3 theme object (`theme` + `theme.extend`) → v4 @theme declarations. Functions are ignored. */
export function themeDeclarations(config: { theme?: ThemeObject } | null | undefined): string[] {
  const theme = config?.theme ?? {};
  const extend = (theme.extend as ThemeObject | undefined) ?? {};
  const out: string[] = [];
  for (const source of [theme, extend]) {
    for (const [key, ns] of Object.entries(NAMESPACES)) {
      const value = source[key];
      if (value && typeof value === "object") flatten(ns, value, out);
    }
  }
  return out;
}

/** Custom-property blocks and v4 @theme blocks from the target's global CSS. */
export function globalVariables(css: string): string {
  const blocks: string[] = [];
  for (const m of css.matchAll(/(:root|\.dark)\s*\{([^{}]*)\}/g)) {
    const decls = [...m[2].matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g)]
      .filter(([, , v]) => safeValue(v.trim()))
      .map(([, k, v]) => `  ${k}: ${v.trim()};`);
    if (decls.length > 0) blocks.push(`${m[1]} {\n${decls.join("\n")}\n}`);
  }
  for (const m of css.matchAll(/@theme(?:\s+inline)?\s*\{([^{}]*)\}/g)) {
    const decls = [...m[1].matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g)]
      .filter(([, , v]) => safeValue(v.trim()))
      .map(([, k, v]) => `  ${k}: ${v.trim()};`);
    if (decls.length > 0) blocks.push(`@theme {\n${decls.join("\n")}\n}`);
  }
  return blocks.join("\n\n");
}

const trusted = createRequire(path.join(VIDEO_DIR, "package.json"));
/** Tailwind's own helpers, loaded from the renderer's installation (never from the target repo). */
const TRUSTED_MODULES: Record<string, () => unknown> = {
  "tailwindcss/colors": () => trusted("tailwindcss/colors") as unknown,
  "tailwindcss/defaultTheme": () => trusted("tailwindcss/defaultTheme") as unknown,
  "tailwindcss/default-theme": () => trusted("tailwindcss/defaultTheme") as unknown,
};
const unwrapDefault = (m: unknown) => (m && typeof m === "object" && "default" in m ? (m as { default: unknown }).default : m);

type ModuleValue = { default: unknown; named: Map<string, unknown> };

/**
 * Statically evaluate a config module: object/array/string/number literals, spreads, `const`
 * bindings, member access, relative imports (parsed the same way) and Tailwind's own helpers.
 * Anything else — calls, functions, plugins — evaluates to undefined. The target repository's
 * code is never executed: the action process holds secrets (API key, OIDC token, git creds).
 */
function evaluateModule(file: string, depth = 0): ModuleValue {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, () => unknown>();
  const cache = new Map<string, unknown>();
  const resolving = new Set<string>();
  const result: ModuleValue = { default: undefined, named: new Map() };

  const load = (spec: string): unknown => {
    if (TRUSTED_MODULES[spec]) return TRUSTED_MODULES[spec]();
    if (!spec.startsWith(".") || depth >= 3) return undefined;
    const base = path.resolve(path.dirname(file), spec);
    const target = [base, ...[".ts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"].map((e) => base + e)].find(
      (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
    );
    if (!target) return undefined;
    const mod = evaluateModule(target, depth + 1);
    return { default: mod.default, ...Object.fromEntries(mod.named) };
  };
  const lookup = (name: string): unknown => {
    if (cache.has(name)) return cache.get(name);
    const get = bindings.get(name);
    if (!get || resolving.has(name)) return undefined;
    resolving.add(name);
    const value = get();
    resolving.delete(name);
    cache.set(name, value);
    return value;
  };
  const propName = (n: ts.PropertyName): string | undefined =>
    ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;

  const evaluate = (node: ts.Node): unknown => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))
      return evaluate(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) return lookup(node.text);
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((el) => {
        if (ts.isSpreadElement(el)) {
          const v = evaluate(el.expression);
          return Array.isArray(v) ? v : [];
        }
        return [evaluate(el)];
      });
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const key = propName(prop.name);
          if (key !== undefined) out[key] = evaluate(prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) out[prop.name.text] = lookup(prop.name.text);
        else if (ts.isSpreadAssignment(prop)) {
          const v = evaluate(prop.expression);
          if (v && typeof v === "object") Object.assign(out, v);
        }
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = evaluate(node.expression);
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      return obj && typeof obj === "object" && key !== undefined ? (obj as Record<string, unknown>)[key] : undefined;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      return arg && ts.isStringLiteral(arg) ? load(arg.text) : undefined;
    }
    return undefined; // calls, functions, operators: not evaluated
  };

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause && !stmt.importClause.isTypeOnly) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause.name) bindings.set(clause.name.text, () => unwrapDefault(load(spec)));
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, () => load(spec));
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text;
          bindings.set(el.name.text, () => {
            const mod = load(spec) as Record<string, unknown> | undefined;
            return mod?.[imported] ?? (unwrapDefault(mod) as Record<string, unknown> | undefined)?.[imported];
          });
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        const name = decl.name.text;
        bindings.set(name, () => evaluate(init));
        if (exported) result.named.set(name, undefined);
      }
    } else if (ts.isExportAssignment(stmt)) {
      const expr = stmt.expression;
      bindings.set("__default", () => evaluate(expr));
    } else if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      stmt.expression.left.getText(source) === "module.exports"
    ) {
      const right = stmt.expression.right;
      bindings.set("__default", () => evaluate(right));
    }
  }
  result.default = lookup("__default");
  for (const name of result.named.keys()) result.named.set(name, lookup(name));
  return result;
}

/** Read a tailwind.config.{ts,js,mjs,cjs} without executing it (see evaluateModule). */
export async function loadTailwindConfig(configPath: string): Promise<{ theme?: ThemeObject } | null> {
  try {
    const config = evaluateModule(configPath).default;
    return config && typeof config === "object" ? (config as { theme?: ThemeObject }) : null;
  } catch {
    return null;
  }
}

/** Write the renderer's target-theme.css. Returns the number of theme declarations written. */
export async function writeTargetTheme(input: { configPath: string | null; globalsCss: string }): Promise<number> {
  const config = input.configPath ? await loadTailwindConfig(input.configPath) : null;
  const decls = themeDeclarations(config);
  const vars = globalVariables(input.globalsCss);
  const parts = [PLACEHOLDER.trim()];
  if (decls.length > 0) parts.push(`@theme {\n${decls.join("\n")}\n}`);
  if (vars) parts.push(vars);
  fs.writeFileSync(TARGET_THEME_FILE, `${parts.join("\n\n")}\n`);
  return decls.length + (vars.match(/;\n/g)?.length ?? 0);
}

/** Back to the empty theme (offline demos, and the retry after a theme-related render failure). */
export function resetTargetTheme(): void {
  fs.writeFileSync(TARGET_THEME_FILE, PLACEHOLDER);
}
