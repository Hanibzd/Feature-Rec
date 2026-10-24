import { Easing } from "remotion";

/**
 * Deterministic CSS transitions for real components.
 *
 * A click replayed by the Stage changes the component's state; in a frame-by-frame render the
 * browser would not play the component's CSS transitions reliably. So the styles of every
 * element that declares a transition are snapshotted right before the click, and after the
 * click they are interpolated toward the new values with the element's own
 * transition-property / duration / delay / timing-function — what the real browser would show.
 */

const COLOR = /color$|^fill$|^stroke$/;
const SUPPORTED = new Set([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "fill",
  "stroke",
  "opacity",
  "transform",
  "translate",
  "scale",
  "rotate",
  "box-shadow",
  "width",
  "height",
  "left",
  "right",
  "top",
  "bottom",
]);
const EXPAND: Record<string, string[]> = {
  all: [...SUPPORTED],
  "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
  background: ["background-color"],
};

/**
 * Real browser transitions are frozen inside the Stage (duration 0): they run on the wall
 * clock, so they would make frames depend on render timing, and they would fight with the
 * emulation below. The declared values are read by briefly lifting the freeze.
 */
const FREEZE = "data-fr-freeze";
if (typeof document !== "undefined" && !document.getElementById("fr-freeze-transitions")) {
  const style = document.createElement("style");
  style.id = "fr-freeze-transitions";
  style.textContent = `[${FREEZE}] *, [${FREEZE}] *::before, [${FREEZE}] *::after { transition-duration: 0s !important; transition-delay: 0s !important; }`;
  document.head.appendChild(style);
}

type Entry = { from: Record<string, string>; dur: number; delay: number; ease: (t: number) => number };
export type TransitionSnapshot = Map<HTMLElement, Entry>;
export type InlineBackup = Map<HTMLElement, Map<string, [string, string]>>;

const seconds = (v: string) => (v.trim().endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v)) || 0;

function easing(fn: string): (t: number) => number {
  const f = fn.split(",")[0].trim();
  const m = /cubic-bezier\(([^)]+)\)/.exec(fn);
  if (m) {
    const [a, b, c, d] = m[1].split(",").map(Number);
    return Easing.bezier(a, b, c, d);
  }
  if (f === "linear") return (t) => t;
  if (f === "ease-in") return Easing.bezier(0.42, 0, 1, 1);
  if (f === "ease-out") return Easing.bezier(0, 0, 0.58, 1);
  if (f === "ease-in-out") return Easing.bezier(0.42, 0, 0.58, 1);
  return Easing.bezier(0.25, 0.1, 0.25, 1); // "ease"
}

export function snapshotTransitions(root: HTMLElement): TransitionSnapshot {
  const snap: TransitionSnapshot = new Map();
  const host = root.closest<HTMLElement>(`[${FREEZE}]`);
  host?.removeAttribute(FREEZE); // read the component's declared transitions…
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    const cs = getComputedStyle(el);
    const durs = cs.transitionDuration.split(",").map(seconds);
    if (Math.max(...durs) <= 0) continue;
    const props = cs.transitionProperty
      .split(",")
      .map((p) => p.trim())
      .flatMap((p) => EXPAND[p] ?? [p])
      .filter((p) => SUPPORTED.has(p));
    if (props.length === 0) continue;
    const from: Record<string, string> = {};
    for (const p of props) from[p] = cs.getPropertyValue(p);
    snap.set(el, {
      from,
      dur: Math.max(...durs) * 1000,
      delay: seconds(cs.transitionDelay.split(",")[0]) * 1000,
      ease: easing(cs.transitionTimingFunction),
    });
  }
  host?.setAttribute(FREEZE, ""); // …then freeze again (transition-* changes never animate)
  return snap;
}

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
function lerpValue(prop: string, from: string, to: string, t: number): string {
  if (from === to) return to;
  if (COLOR.test(prop)) return `color-mix(in oklab, ${from} ${((1 - t) * 100).toFixed(2)}%, ${to})`;
  const a = from === "none" && to.startsWith("matrix(") ? "matrix(1, 0, 0, 1, 0, 0)" : from;
  const b = to === "none" && a.startsWith("matrix(") ? "matrix(1, 0, 0, 1, 0, 0)" : to;
  if (a.replace(NUM, "#") !== b.replace(NUM, "#")) return t < 0.5 ? from : to;
  const xs = a.match(NUM) ?? [];
  const ys = b.match(NUM) ?? [];
  let i = 0;
  return a.replace(NUM, () => {
    const v = parseFloat(xs[i]) + (parseFloat(ys[i]) - parseFloat(xs[i])) * t;
    i++;
    return String(Number(v.toFixed(4)));
  });
}

/** Restore the inline styles we overrode (keeps the component's own inline values). */
export function restoreInline(backup: InlineBackup): void {
  for (const [el, props] of backup) {
    for (const [prop, [value, priority]] of props) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  }
  backup.clear();
}

export function setInline(backup: InlineBackup, el: HTMLElement, prop: string, value: string): void {
  let props = backup.get(el);
  if (!props) backup.set(el, (props = new Map()));
  if (!props.has(prop)) props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  el.style.setProperty(prop, value);
}

/** Interpolate from the snapshot toward the current (post-click) styles, `sinceMs` after the click. */
export function applyTransitions(snap: TransitionSnapshot, sinceMs: number, backup: InlineBackup): void {
  const plan: Array<[HTMLElement, string, string]> = [];
  for (const [el, e] of snap) {
    if (!el.isConnected) continue;
    const t = e.ease(Math.min(1, Math.max(0, (sinceMs - e.delay) / Math.max(e.dur, 1))));
    if (t >= 1) continue;
    const cs = getComputedStyle(el);
    for (const [prop, from] of Object.entries(e.from)) {
      const to = cs.getPropertyValue(prop);
      if (to !== from) plan.push([el, prop, lerpValue(prop, from, to, t)]);
    }
  }
  // read everything first, then write (no layout thrash between elements)
  for (const [el, prop, value] of plan) setInline(backup, el, prop, value);
}
