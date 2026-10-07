import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VIDEO_SRC } from "../paths";

/**
 * The target repository's Tailwind theme, made available to the renderer.
 *
 * The renderer runs stock Tailwind v4. Without the target's theme, custom utilities such as
 * `bg-brand-600`, `rounded-card` or shadcn's `text-muted-foreground` produce no CSS. This module
 * turns the target's tailwind.config (v3 style) into v4 `@theme` variables, and carries over the
 * CSS custom properties its globals define (`:root`, `.dark`) plus any v4 `@theme` blocks.
 * Values are sanitized: a bad theme must never break the render (the caller also retries
 * without it).
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
    if (safeValue(v)) out.push(`  --${prefix}: ${v};`);
    return;
  }
  if (Array.isArray(value)) {
    // fontFamily: ["Inter", "sans-serif"]; fontSize: ["0.875rem", { lineHeight: "1.25rem" }]
    if (prefix.startsWith("font-") && value.every((v) => typeof v === "string")) {
      const v = value.map((f: string) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(", ");
      if (safeValue(v)) out.push(`  --${prefix}: ${v};`);
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

/**
 * Load a tailwind.config.{ts,js,mjs,cjs}. Plugins are not executed (their packages are not
 * installed here): the `plugins` array and non-relative imports other than tailwindcss are
 * stripped from a temporary copy written next to the original, so relative imports still work.
 */
export async function loadTailwindConfig(configPath: string): Promise<{ theme?: ThemeObject } | null> {
  const source = fs.readFileSync(configPath, "utf8");
  const sanitized = source
    .replace(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](?!\.|tailwindcss)[^"']+["'];?\s*$/gm, "")
    .replace(/require\(\s*["'](?!\.)[^"']+["']\s*\)/g, "undefined")
    .replace(/plugins\s*:\s*\[[\s\S]*?\]\s*(,?)/, "plugins: []$1");
  const tmp = path.join(path.dirname(configPath), `.feature-rec-tailwind${path.extname(configPath)}`);
  fs.writeFileSync(tmp, sanitized);
  try {
    const mod = (await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`)) as { default?: unknown };
    const config = (mod.default ?? mod) as { theme?: ThemeObject };
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
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
