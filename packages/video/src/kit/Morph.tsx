import React, { useLayoutEffect, useRef } from "react";
import { staggered, useProgress } from "./motion";
import { restoreInline, setInline, type InlineBackup } from "./transitions";

/**
 * The REAL before and after components of the PR, animated by diffing their DOM.
 *
 * What is on screen is always the real AFTER component (fidelity by construction). The
 * BEFORE component is rendered invisibly next to it, the two DOM trees are matched, and on
 * every frame the AFTER DOM is styled back toward BEFORE according to the progress:
 *  - elements that are new in AFTER grow from zero size (height in a column, width in a row)
 *    while fading in, so siblings move naturally — like <Reveal>;
 *  - matched elements whose look changed interpolate width/height, colors, borders, radius;
 *  - text that changed fades out and back in with the new words.
 * Nothing is retyped. If elements were removed (they no longer exist in AFTER) or there is
 * no BEFORE, it falls back to a cross-fade.
 */

type Pair = { b: HTMLElement; a: HTMLElement };
type Plan = { added: HTMLElement[]; changed: Pair[]; removed: number } | null;

const COLOR_PROPS = [
  "backgroundColor",
  "color",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
] as const;
const NUM_PROPS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius", "opacity"] as const;

const directText = (el: Element) =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Longest-common-subsequence matching of two child lists under an equality. */
function lcs<T>(xs: T[], ys: T[], eq: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = xs.length;
  const m = ys.length;
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i][j] = eq(xs[i], ys[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(xs[i], ys[j])) out.push([i++, j++]);
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function diff(b: HTMLElement, a: HTMLElement, plan: NonNullable<Plan>): void {
  if (b.getAttribute("class") !== a.getAttribute("class") || directText(b) !== directText(a)) plan.changed.push({ b, a });
  const bc = Array.from(b.children) as HTMLElement[];
  const ac = Array.from(a.children) as HTMLElement[];
  // Pass 1: same tag and same full text (classes may differ). Pass 2: same tag, in order.
  const first = lcs(bc, ac, (x, y) => x.tagName === y.tagName && norm(x.textContent) === norm(y.textContent));
  const usedB = new Set(first.map(([i]) => i));
  const usedA = new Set(first.map(([, j]) => j));
  const restB = bc.map((_, i) => i).filter((i) => !usedB.has(i));
  const restA = ac.map((_, j) => j).filter((j) => !usedA.has(j));
  const second = lcs(restB, restA, (i, j) => bc[i].tagName === ac[j].tagName).map(([x, y]) => [restB[x], restA[y]] as [number, number]);
  const pairs = [...first, ...second];
  const matchedA = new Set(pairs.map(([, j]) => j));
  plan.removed += bc.length - pairs.length;
  ac.forEach((el, j) => {
    if (!matchedA.has(j)) plan.added.push(el);
  });
  for (const [i, j] of pairs) diff(bc[i], ac[j], plan);
}

const lerp = (x: number, y: number, p: number) => x + (y - x) * p;
const mix = (from: string, to: string, p: number) =>
  from === to ? to : `color-mix(in oklab, ${from} ${((1 - p) * 100).toFixed(2)}%, ${to})`;

export const Morph: React.FC<{
  at: number;
  /** frames; ~18 matches the kit's other motions */
  duration?: number;
  before: React.ReactNode;
  after: React.ReactNode;
}> = ({ at, duration = 18, before, after }) => {
  const p = useProgress(at, duration);
  const boxRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<Plan | undefined>(undefined);
  const touched = useRef<InlineBackup>(new Map());
  const texts = useRef(new Map<Text, string>());

  useLayoutEffect(() => {
    const box = boxRef.current;
    const ghost = ghostRef.current;
    const root = afterRef.current;
    if (!box || !ghost || !root) return;

    // 1. Back to the natural AFTER state.
    restoreInline(touched.current); // back to the component's own inline styles
    for (const [node, value] of texts.current) node.data = value;
    texts.current.clear();
    box.dataset.finalHeight = String(root.offsetHeight);

    // 2. Match the trees once (the DOM nodes persist across frames).
    if (planRef.current === undefined) {
      const bRoot = ghost.firstElementChild as HTMLElement | null;
      const aRoot = root.firstElementChild as HTMLElement | null;
      if (!bRoot || !aRoot) planRef.current = null;
      else {
        const plan = { added: [], changed: [], removed: 0 } as NonNullable<Plan>;
        diff(bRoot, aRoot, plan);
        planRef.current = plan.removed > 0 ? null : plan; // removed elements can't be shown: cross-fade
      }
    }
    const plan = planRef.current;
    const set = (el: HTMLElement, prop: string, value: string) => setInline(touched.current, el, prop, value);
    if (p >= 1) return;
    if (!plan) {
      // Fallback: plain cross-fade between the two real components.
      set(ghost, "visibility", "visible");
      const [out, into] = staggered(p);
      set(ghost, "opacity", String(out));
      set(root, "opacity", String(into));
      return;
    }
    const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

    // 3. Measure everything in the natural AFTER state first…
    const changed = plan.changed.map(({ b, a }) => ({
      b,
      a,
      cb: getComputedStyle(b),
      ca: getComputedStyle(a),
      bw: b.offsetWidth,
      aw: a.offsetWidth,
      bh: b.offsetHeight,
      ah: a.offsetHeight,
      bt: directText(b),
      at: directText(a),
      hasAdded: plan.added.some((n) => a.contains(n)),
    }));
    const added = plan.added.map((el) => {
      const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const cs = getComputedStyle(el);
      return {
        el,
        row: (parent?.display.includes("flex") && !parent.flexDirection.startsWith("column")) || cs.display.startsWith("inline"),
        w: el.offsetWidth,
        h: el.offsetHeight,
        ml: parseFloat(cs.marginLeft) || 0,
        mr: parseFloat(cs.marginRight) || 0,
        mt: parseFloat(cs.marginTop) || 0,
        mb: parseFloat(cs.marginBottom) || 0,
        opacity: parseFloat(cs.opacity) || 1,
      };
    });
    const cs = changed.map((c) => ({
      ...c,
      colors: COLOR_PROPS.map((prop) => [prop, c.cb[prop], c.ca[prop]] as const),
      nums: NUM_PROPS.map((prop) => [prop, parseFloat(c.cb[prop]), parseFloat(c.ca[prop])] as const),
    }));

    // …then style the AFTER DOM back toward BEFORE.
    for (const c of cs) {
      for (const [prop, x, y] of c.colors) if (x !== y) set(c.a, kebab(prop), mix(x, y, p));
      for (const [prop, x, y] of c.nums)
        if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) > 0.01)
          set(c.a, kebab(prop), `${lerp(x, y, p)}${prop === "opacity" ? "" : "px"}`);
      if (Math.abs(c.bw - c.aw) > 0.5) set(c.a, "width", `${lerp(c.bw, c.aw, p)}px`);
      if (!c.hasAdded && Math.abs(c.bh - c.ah) > 0.5) set(c.a, "height", `${lerp(c.bh, c.ah, p)}px`);
      if (c.bt !== c.at) {
        // Changed words: fade out the old text, fade in the new one.
        set(c.a, "white-space", "nowrap"); // the box is resizing: keep the words on one line
        set(c.a, "overflow", "clip");
        const k = Math.abs(1 - 2 * p);
        set(c.a, "color", `color-mix(in oklab, ${mix(c.cb.color, c.ca.color, p)} ${(k * 100).toFixed(2)}%, transparent)`);
        if (p < 0.5) {
          const nodes = Array.from(c.a.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE && !!(n as Text).data.trim());
          nodes.forEach((n, i) => {
            texts.current.set(n, n.data);
            n.data = i === 0 ? c.bt : "";
          });
        }
      }
    }
    for (const n of added) {
      const fade = Math.min(1, Math.max(0, (p - 0.3) / 0.7));
      set(n.el, "overflow", "clip");
      set(n.el, "overflow-clip-margin", "6px");
      set(n.el, "opacity", String(fade * n.opacity));
      if (n.row) {
        set(n.el, "width", `${n.w * p}px`);
        set(n.el, "min-width", "0px");
        set(n.el, "flex-shrink", "0");
        set(n.el, "white-space", "nowrap");
        set(n.el, "margin-left", `${n.ml * p}px`);
        set(n.el, "margin-right", `${n.mr * p}px`);
      } else {
        set(n.el, "height", `${n.h * p}px`);
        set(n.el, "margin-top", `${n.mt * p}px`);
        set(n.el, "margin-bottom", `${n.mb * p}px`);
      }
    }
  });

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      {/* BEFORE, invisible: only read to compute the diff (and shown for the cross-fade fallback). */}
      <div
        ref={ghostRef}
        data-morph-ghost=""
        style={{
          position: "absolute",
          inset: "0 0 auto 0",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        {before}
      </div>
      <div ref={afterRef}>
        {after}
      </div>
    </div>
  );
};
