import React, { createContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { PointerArrow, PointerText } from "./Pointer";
import { applyTransitions, restoreInline, snapshotTransitions, type InlineBackup, type TransitionSnapshot } from "./transitions";

/**
 * Screen-recording stage for generated scenes.
 *
 * - Frames the whole UI (`data-focus="ui"`) at its FINAL size (pending Reveals included), so it
 *   is fully visible and the framing does not move while elements grow in.
 * - `focus` moments may nudge the camera toward a changed element; the zoom is decided
 *   here, never by the scene: none for elements that already read well, at most +25%
 *   for small ones, and the UI stays anchored on screen.
 * - Draws a macOS pointer that travels between targets and clicks, and tells the scene
 *   which element is hovered / pressed so it can render the component's real
 *   hover:/active: states.
 * No glows, no dimming, no captions: the UI and the pointer tell the story.
 */

type Rect = { x: number; y: number; w: number; h: number };
/** data-focus id, a screen point, an element by its exact visible text, or a CSS selector. */
export type PointerTarget = string | { x: number; y: number } | { text: string } | { selector: string };
type FocusMoment = { from: number; id?: string; text?: string; selector?: string };
const keyOf = (t: PointerTarget | FocusMoment | null | undefined): string | null =>
  t == null || (typeof t !== "string" && typeof t !== "object")
    ? null
    : typeof t === "string"
    ? t
    : "text" in t && t.text !== undefined
      ? `text:${t.text}`
      : "selector" in t && t.selector !== undefined
        ? `sel:${t.selector}`
        : "id" in t && t.id !== undefined
          ? t.id
          : null;
export type StageState = {
  frame: number;
  hovered: (id: string) => boolean;
  pressed: (id: string) => boolean;
};

/** Screen-space layer for full-screen UI (modals, drawers, toasts) + current camera scale. */
export const StageContext = createContext<{ overlay: HTMLElement | null; scale: number }>({ overlay: null, scale: 1 });

const CAMERA = { damping: 200, stiffness: 40, mass: 1 } as const;
const OVERVIEW_FILL = 0.84;
const MAX_OVERVIEW_SCALE = 1.8;
const MAX_NUDGE = 1.25;
/** Scale at which typical 14px UI text reads comfortably on a phone. */
const LEGIBLE_SCALE = 1.6;

const same = (a: Record<string, Rect>, b: Record<string, Rect>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => {
    const r = a[k];
    const s = b[k];
    return s && Math.abs(r.x - s.x) < 0.01 && Math.abs(r.y - s.y) < 0.01 && Math.abs(r.w - s.w) < 0.01 && Math.abs(r.h - s.h) < 0.01;
  });

export const Stage: React.FC<{
  children: React.ReactNode | ((s: StageState) => React.ReactNode);
  /** Moments the camera eases toward an element ("ui" = back to the whole UI). */
  focus?: FocusMoment[];
  pointer?: {
    /** Waypoints. A string is a data-focus id (lands on its center); {x,y} is a screen point. */
    path: Array<{ frame: number; to: PointerTarget }>;
    clicks?: number[];
  };
  /** Layout width of the page, like a browser viewport. */
  viewportWidth?: number;
  background?: string;
  fontFamily?: string;
}> = ({ children, focus = [], pointer, viewportWidth = 1440, background = "#F6F7FB", fontFamily }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const applied = useRef(1);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [handle] = useState(() => delayRender("Stage: measuring"));
  const released = useRef(false);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);

  // Real clicks: every pointer click up to this frame is replayed, in order, as a DOM click on
  // the element it targets, so real components run their own onClick/state. Children are
  // remounted whenever the number of past clicks changes, which keeps frames deterministic even
  // when they are rendered out of order.
  const pastClicks = (pointer?.clicks ?? []).filter((c) => c <= frame).sort((a, b) => a - b);
  const replayed = useRef<{ key: number; done: boolean }>({ key: -1, done: false });
  const [, setTick] = useState(0);
  const transSnap = useRef<TransitionSnapshot | null>(null);
  const transBackup = useRef<InlineBackup>(new Map());
  if (replayed.current.key !== pastClicks.length) replayed.current = { key: pastClicks.length, done: false };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    restoreInline(transBackup.current);
    if (!replayed.current.done) {
      replayed.current.done = true;
      transSnap.current = null;
      const path = [...(pointer?.path ?? [])].sort((a, b) => a.frame - b.frame);
      // Compute styles of the freshly mounted DOM first: CSS transitions only start from an
      // already-computed style, otherwise the clicked state would snap instead of animating.
      root.getBoundingClientRect();
      for (const c of pastClicks) {
        const target = [...path].reverse().find((w) => w.frame <= c)?.to;
        const k = target === undefined ? null : keyOf(target);
        if (!k) continue;
        const scopes = [root, ...(overlay ? [overlay] : [])];
        let el: HTMLElement | null = null;
        for (const sc of scopes) {
          if (el) break;
          if (k.startsWith("sel:")) el = sc.querySelector<HTMLElement>(k.slice(4));
          else if (k.startsWith("text:")) {
            let best = Infinity;
            sc.querySelectorAll<HTMLElement>("*").forEach((n) => {
              if (n.closest("[data-morph-ghost]") || n.textContent?.trim() !== k.slice(5)) return;
              const r = n.getBoundingClientRect();
              if (r.width * r.height > 0 && r.width * r.height < best) { best = r.width * r.height; el = n; }
            });
          } else el = sc.querySelector<HTMLElement>(`[data-focus="${k}"]`);
        }
        // Snapshot styles right before the last click, to replay the components' transitions.
        if (c === pastClicks[pastClicks.length - 1]) transSnap.current = snapshotTransitions(root);
        (el as HTMLElement | null)?.click();
      }
      // Re-render now so the clicked components' state updates land before this frame is shot.
      if (pastClicks.length > 0) setTick((t) => t + 1);
    }

    // The components' own CSS transitions/animations, driven by the frame instead of the clock:
    // a transition plays from the last click; anything else is settled (or at scene time).
    const lastClick = pastClicks[pastClicks.length - 1];
    const sinceClick = lastClick === undefined ? Infinity : ((frame - lastClick) / fps) * 1000;
    if (transSnap.current && Number.isFinite(sinceClick)) applyTransitions(transSnap.current, sinceClick, transBackup.current);
    for (const anim of root.getAnimations({ subtree: true })) {
      anim.pause();
      if (anim instanceof CSSTransition) anim.finish(); // emulated above, frame-accurately
      else anim.currentTime = (frame / fps) * 1000; // keyframe animations follow scene time
    }
    // Measure in UI coordinates WITHOUT the camera transform, so the result never depends on
    // the previous frame's camera (deterministic whatever order frames are rendered in).
    // Overlay (modal) content lives in screen space and is converted with the current camera.
    const sT = applied.current;
    const rrT = root.getBoundingClientRect();
    const cameraTransform = root.style.transform;
    root.style.transform = "none";
    const rr = root.getBoundingClientRect();
    const toUi = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return overlay?.contains(el)
        ? { x: (r.left - rrT.left) / sT, y: (r.top - rrT.top) / sT, w: r.width / sT, h: r.height / sT }
        : { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height };
    };
    const next: Record<string, Rect> = { __root: { x: 0, y: 0, w: rr.width, h: rr.height } };
    const focusEls = [
      ...root.querySelectorAll<HTMLElement>("[data-focus]"),
      ...(overlay?.querySelectorAll<HTMLElement>("[data-focus]") ?? []),
    ];
    focusEls.filter((el) => !el.closest("[data-morph-ghost]")).forEach((el) => {
      next[el.dataset.focus as string] = toUi(el);
    });
    // Targets given by visible text or selector (real, untouched components have no data-focus).
    const scopes = [root, ...(overlay ? [overlay] : [])];
    const wanted = new Set<string>();
    for (const m of focus) { const k = keyOf(m); if (k) wanted.add(k); }
    for (const w of pointer?.path ?? []) { const k = keyOf(w.to); if (k) wanted.add(k); }
    for (const k of wanted) {
      let el: Element | null = null;
      if (k.startsWith("text:")) {
        const text = k.slice(5);
        let best = Infinity;
        for (const sc of scopes) {
          sc.querySelectorAll("*").forEach((c) => {
            if (c.textContent?.trim() !== text || c.closest("[data-morph-ghost]")) return;
            const r = c.getBoundingClientRect();
            if (r.width * r.height > 0 && r.width * r.height < best) { best = r.width * r.height; el = c; }
          });
        }
      } else if (k.startsWith("sel:")) {
        for (const sc of scopes) el = el ?? sc.querySelector(k.slice(4));
      }
      if (el) next[k] = toUi(el);
    }
    // A <PageHint> is context, not part of the component: if it sits inside the "ui"
    // element, frame only the ui's other children.
    const uiNode = root.querySelector<HTMLElement>('[data-focus="ui"]');
    const hint = uiNode?.querySelector<HTMLElement>("[data-page-hint]");
    if (uiNode && hint) {
      let branch: HTMLElement = hint;
      while (branch.parentElement && branch.parentElement !== uiNode) branch = branch.parentElement;
      const others = Array.from(uiNode.children).filter((c) => c !== branch) as HTMLElement[];
      if (others.length > 0) {
        const rs = others.map(toUi);
        const left = Math.min(...rs.map((r) => r.x));
        const top = Math.min(...rs.map((r) => r.y));
        const right = Math.max(...rs.map((r) => r.x + r.w));
        const bottom = Math.max(...rs.map((r) => r.y + r.h));
        next.ui = { x: left, y: top, w: right - left, h: bottom - top };
      }
    }
    // Height the UI will gain once every vertical <Reveal> has finished: framing uses the
    // final size, so the camera never "pumps" while an element grows in.
    const uiEl = uiNode ?? root;
    let pending = 0;
    uiEl.querySelectorAll<HTMLElement>('[data-reveal="y"]').forEach((el) => {
      const content = el.firstElementChild?.firstElementChild as HTMLElement | null | undefined;
      if (content) pending += Math.max(0, content.getBoundingClientRect().height - el.getBoundingClientRect().height);
    });
    // <Morph> declares its final (AFTER) height.
    uiEl.querySelectorAll<HTMLElement>("[data-final-height]").forEach((el) => {
      pending += Math.max(0, Number(el.dataset.finalHeight) - el.offsetHeight);
    });
    root.style.transform = cameraTransform;
    next.__pending = { x: 0, y: 0, w: 0, h: pending };
    if (!same(rects, next)) setRects(next);
  });
  useEffect(() => {
    if (!released.current && Object.keys(rects).length > 0) {
      released.current = true;
      continueRender(handle);
    }
  }, [rects, handle]);

  const rectOf = (id: string): Rect => rects[id] ?? rects.ui ?? rects.__root ?? { x: 0, y: 0, w: width, h: height };
  const current = rectOf("ui");
  const ui: Rect = { ...current, h: current.h + (rects.__pending?.h ?? 0) }; // final size of the UI
  const fitUi = (fill: number) => Math.min((width * fill) / Math.max(ui.w, 1), (height * fill) / Math.max(ui.h, 1));
  const overview = Math.min(fitUi(OVERVIEW_FILL), MAX_OVERVIEW_SCALE);
  // Headers and toolbars: too wide to be readable whole, so a focus may crop them.
  const wide = ui.w / Math.max(ui.h, 1) > 5;

  const framing = (id: string) => {
    const r = rectOf(id);
    // Nudge only when the element is small on screen at overview size.
    const onScreen = Math.min(r.h * overview, (r.w * overview) / 3);
    const nudge = interpolate(onScreen, [36, 110], [MAX_NUDGE, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    // Wide UIs (headers, toolbars) end up at a small overview scale: when focusing one of
    // their parts, still reach a readable size, but never more than 1.6x the overview.
    // Everything else: the whole component always stays in frame.
    const s =
      id === "ui"
        ? overview
        : wide
          ? Math.max(overview * nudge, Math.min(LEGIBLE_SCALE, overview * 1.6))
          : Math.max(overview, Math.min(overview * nudge, fitUi(0.9)));
    const halfW = width / (2 * s);
    const halfH = height / (2 * s);
    const axis = (c: number, lo: number, hi: number, half: number) =>
      hi - lo <= 2 * half ? (lo + hi) / 2 : Math.min(Math.max(c, lo + half), hi - half);
    return {
      ls: Math.log(s),
      cx: axis(r.x + r.w / 2, Math.min(ui.x, r.x), Math.max(ui.x + ui.w, r.x + r.w), halfW),
      cy: axis(r.y + r.h / 2, Math.min(ui.y, r.y), Math.max(ui.y + ui.h, r.y + r.h), halfH),
    };
  };

  // Wide UIs without explicit focus: follow what the pointer goes to, so the part being
  // used becomes readable (the camera starts moving when the pointer does).
  let moments = focus.flatMap((m) => { const k = keyOf(m); return k ? [{ from: m.from, id: k }] : []; });
  if (moments.length === 0 && wide && pointer) {
    const path = [...pointer.path].sort((a, b) => a.frame - b.frame);
    moments = path.flatMap((p, i) => {
      const k = keyOf(p.to);
      return k && (i === 0 || keyOf(path[i - 1].to) !== k)
        ? [{ from: i > 0 ? path[i - 1].frame : Math.max(0, p.frame - 20), id: k }]
        : [];
    });
  }
  const shots = [{ from: 0, id: "ui" }, ...moments].sort((a, b) => a.from - b.from);
  let cam = framing(shots[0].id);
  for (let i = 1; i < shots.length; i++) {
    const a = framing(shots[i - 1].id);
    const b = framing(shots[i].id);
    const p = spring({ frame: frame - shots[i].from, fps, config: CAMERA });
    cam = { ls: cam.ls + (b.ls - a.ls) * p, cx: cam.cx + (b.cx - a.cx) * p, cy: cam.cy + (b.cy - a.cy) * p };
  }
  const scale = Math.exp(cam.ls);
  applied.current = scale;
  const tx = width / 2 - cam.cx * scale;
  const ty = height / 2 - cam.cy * scale;
  const toScreen = (t: PointerTarget) => {
    const k = keyOf(t);
    if (!k) return t && typeof t === "object" && "x" in t ? t : { x: width / 2, y: height * 0.8 };
    const r = rectOf(k);
    return { x: tx + (r.x + r.w / 2) * scale, y: ty + (r.y + r.h / 2) * scale };
  };

  // Pointer.
  let pos: { x: number; y: number } | null = null;
  let press = 1;
  const clicks = pointer?.clicks ?? [];
  if (pointer && pointer.path.length > 0) {
    const path = [...pointer.path].sort((a, b) => a.frame - b.frame);
    pos = toScreen(path[0].to);
    for (let i = 1; i < path.length; i++) {
      if (frame >= path[i].frame) pos = toScreen(path[i].to);
      else if (frame > path[i - 1].frame) {
        const t = interpolate(frame, [path[i - 1].frame, path[i].frame], [0, 1], { easing: Easing.bezier(0.45, 0, 0.2, 1) });
        const a = toScreen(path[i - 1].to);
        const b = toScreen(path[i].to);
        pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        break;
      }
    }
    for (const c of clicks) {
      if (frame >= c && frame <= c + 8) press = interpolate(frame, [c, c + 3, c + 8], [1, 0.82, 1]);
    }
  }
  const local = pos ? { x: (pos.x - tx) / scale, y: (pos.y - ty) / scale } : null;
  const hovered = (id: string) => {
    const r = rects[id];
    return !!(local && r && local.x >= r.x && local.x <= r.x + r.w && local.y >= r.y && local.y <= r.y + r.h);
  };
  const pressed = (id: string) => hovered(id) && clicks.some((c) => frame >= c && frame <= c + 6);
  const overText = Object.keys(rects).some((id) => {
    const el =
      rootRef.current?.querySelector<HTMLElement>(`[data-focus="${id}"]`) ??
      overlay?.querySelector<HTMLElement>(`[data-focus="${id}"]`);
    return el?.dataset.cursor === "text" && hovered(id);
  });

  return (
    <AbsoluteFill data-fr-freeze="" style={{ background, fontFamily, overflow: "hidden" }}>
      <div
        ref={rootRef}
        // replayed clicks must never navigate or submit the page
        onClickCapture={(e) => {
          if ((e.target as Element).closest("a, form")) e.preventDefault();
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: viewportWidth,
          transformOrigin: "0 0",
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        }}
      >
        <StageContext.Provider value={{ overlay, scale }}>
          <React.Fragment key={pastClicks.length}>
            {typeof children === "function" ? children({ frame, hovered, pressed }) : children}
          </React.Fragment>
        </StageContext.Provider>
      </div>
      <div ref={setOverlay} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      {pos ? overText ? <PointerText x={pos.x} y={pos.y} /> : <PointerArrow x={pos.x} y={pos.y} press={press} /> : null}
    </AbsoluteFill>
  );
};
