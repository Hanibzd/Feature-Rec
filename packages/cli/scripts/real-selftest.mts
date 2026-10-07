/* Self-test for real-component mode (import resolution, retyping guard) and the target theme. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoRetyping, prepareRealComponents, type RevisionReader } from "../src/agent/real.ts";
import { globalVariables, loadTailwindConfig, themeDeclarations } from "../src/agent/theme.ts";
import { withoutComponentsShownInContext } from "../src/feature-rec.ts";
import { GENERATED_DIR } from "../src/paths.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const ID = "zz-real-selftest";
const dir = path.join(GENERATED_DIR, ID);
const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

// A small repository, readable at two revisions.
const repo: Record<string, Record<string, string>> = {
  before: {
    "tsconfig.json": `{ // comments are fine
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, }
    }`,
    "src/components/Card.tsx": `import { Button } from "@/components/ui/button";\nexport function Card() { return <Button>Old</Button>; }`,
    "src/components/ui/button.tsx": `import { cn } from "../../lib/utils";\nexport function Button(p: { children: React.ReactNode }) { return <button className={cn("a")}>{p.children}</button>; }`,
    "src/lib/utils.ts": `import { clsx } from "clsx";\nexport const cn = (...c: string[]) => clsx(c); // before`,
  },
  after: {
    "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }`,
    "src/components/Card.tsx": `import Link from "next/link";\nimport { Button } from "@/components/ui/button";\nimport { Plus } from "lucide-react";\nexport function Card() { return <Link href="/x"><Button><Plus />New</Button></Link>; }`,
    "src/components/ui/button.tsx": `import { cn } from "../../lib/utils";\nexport function Button(p: { children: React.ReactNode }) { return <button className={cn("a")}>{p.children}</button>; }`,
    "src/lib/utils.ts": `import { clsx } from "clsx";\nexport const cn = (...c: string[]) => clsx(c); // after`,
  },
};
const read: RevisionReader = (rev, p) => repo[rev][p] ?? null;
const file = "src/components/Card.tsx";

try {
  const skips: string[] = [];
  const real = prepareRealComponents({
    id: ID,
    file,
    before: repo.before[file],
    after: repo.after[file],
    globalsCss: "body { font-family: Inter, sans-serif; background: #fafafa; }",
    read,
    onSkip: (r) => skips.push(r),
  });
  ok("real mode accepted for an alias + relative + npm + next/link import graph", real !== null && skips.length === 0);
  ok("named exports become Before/After imports", Boolean(real?.importLines.includes(`import { Card as After } from "./${ID}/after/src/components/Card"`)));
  ok("all local files copied for each revision", real?.copied === 3);
  const copiedAfter = fs.readFileSync(path.join(dir, "after", file), "utf8");
  ok("alias rewritten to a relative path", copiedAfter.includes(`from "./ui/button"`));
  ok("next/link rewritten to the render stub", /from "(\.\.\/)+kit\/stubs\/next-link"/.test(copiedAfter));
  ok("npm import the renderer has is kept", copiedAfter.includes(`from "lucide-react"`));
  ok("BEFORE dependencies come from the BEFORE revision", fs.readFileSync(path.join(dir, "before/src/lib/utils.ts"), "utf8").includes("// before"));
  ok("app font and background read from the global CSS", real?.appFont === "Inter, sans-serif" && real?.pageBackground === "#fafafa");

  const unsupported = (after: string) => {
    const reasons: string[] = [];
    const r = prepareRealComponents({
      id: ID,
      file,
      before: "",
      after,
      globalsCss: "",
      read: (rev, p) => (p === file ? after : read(rev, p)),
      onSkip: (x) => reasons.push(x),
    });
    return r === null && reasons.length === 1 && !fs.existsSync(dir);
  };
  ok("unknown npm package falls back to reconstruction", unsupported(`import x from "some-provider-sdk";\nexport function Card() { return <div />; }`));
  ok("CSS module import falls back to reconstruction", unsupported(`import s from "./card.module.css";\nexport function Card() { return <div className={s.a} />; }`));
  ok("dynamic import falls back to reconstruction", unsupported(`export function Card() { void import("./x"); return <div />; }`));

  const noRepo = prepareRealComponents({ id: ID, file, before: "", after: repo.after[file], globalsCss: "" });
  ok("without repository access, only React-only files qualify", noRepo === null);
} finally {
  cleanup();
}

// Retyping guard
const after = `<div className="rounded-2xl bg-white p-8 shadow-xl"><p className="text-sm font-semibold text-slate-900">A</p><span className="mt-0.5 text-xs leading-5 text-slate-500">B</span></div>`;
let threw = false;
try {
  assertNoRetyping(`<div className="rounded-2xl bg-white p-8 shadow-xl"/><p className="text-sm font-semibold text-slate-900"/><span className="mt-0.5 text-xs leading-5 text-slate-500"/>`, after);
} catch {
  threw = true;
}
ok("retyping guard rejects a scene that copies the component's classNames", threw);
let passed = true;
try {
  assertNoRetyping(`<Morph at={30} before={<Before />} after={<After />} />`, after);
} catch {
  passed = false;
}
ok("retyping guard accepts a scene that renders the real files", passed);

// Theme
const decls = themeDeclarations({
  theme: {
    extend: {
      colors: { brand: { 50: "#eef2ff", 600: "#4f46e5", DEFAULT: "#6366f1" }, "bad key!": "#000", border: "hsl(var(--border))" },
      borderRadius: { card: "1rem" },
      fontFamily: { display: ["Cal Sans", "sans-serif"] },
      fontSize: { tiny: ["0.625rem", { lineHeight: "1rem" }] },
      boxShadow: { evil: "0 0 0 red; } body { display: none" },
    },
  },
});
ok("nested colors and DEFAULT flatten to --color-*", decls.includes("  --color-brand-600: #4f46e5;") && decls.includes("  --color-brand: #6366f1;"));
ok("CSS-variable colors are kept", decls.includes("  --color-border: hsl(var(--border));"));
ok("radius, font family and font size map to v4 namespaces", decls.includes("  --radius-card: 1rem;") && decls.includes(`  --font-display: "Cal Sans", sans-serif;`) && decls.includes("  --text-tiny: 0.625rem;"));
ok("unsafe keys and values are dropped", !decls.some((d) => d.includes("bad key") || d.includes("display: none")));
const vars = globalVariables(`@layer base { :root { --primary: 240 5.9% 10%; color: red; } .dark { --primary: 0 0% 98%; } }\n@theme inline { --color-accent: oklch(0.7 0.1 200); }`);
ok("custom properties of :root and .dark are carried over", vars.includes(":root {\n  --primary: 240 5.9% 10%;\n}") && vars.includes(".dark {\n  --primary: 0 0% 98%;\n}") && !vars.includes("color: red"));
ok("v4 @theme blocks are carried over", vars.includes("@theme {\n  --color-accent: oklch(0.7 0.1 200);\n}"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-theme-"));
try {
  const configPath = path.join(tmp, "tailwind.config.ts");
  fs.writeFileSync(path.join(tmp, "tokens.ts"), `export const brand = { 600: "#123456" };\n`);
  fs.writeFileSync(
    configPath,
    `import type { Config } from "tailwindcss";\nimport animate from "tailwindcss-animate-missing";\nimport { brand } from "./tokens";\nexport default {\n  content: ["./src/**/*.tsx"],\n  theme: { extend: { colors: { brand } } },\n  plugins: [animate, require("another-missing-plugin")],\n} satisfies Config;\n`,
  );
  const config = await loadTailwindConfig(configPath);
  ok("TS config with missing plugins and a relative import loads", themeDeclarations(config).includes("  --color-brand-600: #123456;"));
  ok("temporary sanitized config is removed", fs.readdirSync(tmp).every((f) => !f.startsWith(".feature-rec")));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Changed components shown inside another changed file get no scene of their own.
const kept = withoutComponentsShownInContext([
  { file: "src/components/PricingCard.tsx", after: `import { BillingToggle } from "./BillingToggle";` },
  { file: "src/components/BillingToggle.tsx", after: "export function BillingToggle() {}" },
  { file: "app/settings/page.tsx", after: `import Header from "@/components/site/Header";` },
  { file: "src/components/site/Header.tsx", after: "export default function Header() {}" },
  { file: "src/components/Footer.tsx", after: "export function Footer() {}" },
]).map((s) => s.file);
ok("imported changed files are dropped (relative and alias imports)", kept.join(",") === "src/components/PricingCard.tsx,app/settings/page.tsx,src/components/Footer.tsx");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
