import React, { createContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  spring,
  getInputProps,
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
/** Minimum lean-in toward a clicked control (relative to the overview). */
const CLICK_NUDGE = 1.15;
/** Wide chrome (headers, toolbars) fills more of the frame: it is short, so width is the limit. */
const WIDE_OVERVIEW_FILL = 0.94;
/** No framing ever crops the component: a lean-in stops when it fills this much of the frame. */
const MAX_FILL = 0.9;

/** Relative luminance of a #rgb / #rrggbb / rgb() color; light (1) when unknown. */
function luminance(color: string): number {
  const c = color.trim();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((h) => h + h).join("") : hex;
    rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

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
  /** DOM of the real component right before the last click, to detect a click that does nothing. */
  const clickCheck = useRef<{ scope: HTMLElement; html: string; target: string; frame: number } | null>(null);
  if (replayed.current.key !== pastClicks.length) replayed.current = { key: pastClicks.length, done: false };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    restoreInline(transBackup.current);
    if (clickCheck.current) {
      // Second pass after a replay: did the last click change the real component?
      const { scope, html, target, frame: at } = clickCheck.current;
      clickCheck.current = null;
      if (scope.isConnected && scope.innerHTML === html) {
        const message = `Feature-Rec: the pointer click at frame ${at} on ${target} changed nothing in the real component (already selected? not interactive?). Click an element that changes the UI.`;
        if ((getInputProps() as { strictClicks?: boolean }).strictClicks) throw new Error(message);
        console.warn(message);
      }
    }
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
        const clicked = el as HTMLElement | null;
        if (c === pastClicks[pastClicks.length - 1]) {
          transSnap.current = snapshotTransitions(root);
          // Real components only (rendered inside <Morph>): rebuilt UIs have no handlers to run.
          const scope = clicked?.closest<HTMLElement>("[data-final-height]");
          if (scope) clickCheck.current = { scope, html: scope.innerHTML, target: k, frame: c };
        }
        clicked?.click();
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
    // Keys of targets that live in the screen-space overlay (toasts, modals): see framing().
    const inOverlay = (el: Element) => Boolean(overlay?.contains(el));
    const focusEls = [
      ...root.querySelectorAll<HTMLElement>("[data-focus]"),
      ...(overlay?.querySelectorAll<HTMLElement>("[data-focus]") ?? []),
    ];
    focusEls.filter((el) => !el.closest("[data-morph-ghost]")).forEach((el) => {
      next[el.dataset.focus as string] = toUi(el);
      if (inOverlay(el)) next[`overlay:${el.dataset.focus}`] = { x: 0, y: 0, w: 0, h: 0 };
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
      if (el) {
        next[k] = toUi(el);
        if (inOverlay(el)) next[`overlay:${k}`] = { x: 0, y: 0, w: 0, h: 0 };
      }
    }
    // Frame what the component actually paints (backgrounds, borders, shadows, text, media), not
    // the box of the element marked "ui": a full-width wrapper would otherwise shrink the
    // component. A <PageHint> is context and the BEFORE copy inside <Morph> is invisible: both
    // are skipped.
    const uiNode = root.querySelector<HTMLElement>('[data-focus="ui"]');
    if (uiNode) {
      const painted: Rect[] = [];
      let visited = 0;
      const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
      // The element itself counts too: a card's own background, border and padding are its edge.
      const visit = (el: Element) => {
        if (++visited > 4000) return;
        if (el.hasAttribute("data-page-hint") || el.hasAttribute("data-morph-ghost")) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        const r = el.getBoundingClientRect();
        const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        const paints =
          ownText ||
          !transparent(cs.backgroundColor) ||
          cs.backgroundImage !== "none" ||
          cs.boxShadow !== "none" ||
          (parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) > 0 && !transparent(cs.borderTopColor)) ||
          ["IMG", "svg", "VIDEO", "CANVAS", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
        if (paints && r.width > 0 && r.height > 0) painted.push(toUi(el));
        for (const child of Array.from(el.children)) visit(child);
      };
      visit(uiNode);
      if (painted.length > 0) {
        const left = Math.min(...painted.map((r) => r.x));
        const top = Math.min(...painted.map((r) => r.y));
        const right = Math.max(...painted.map((r) => r.x + r.w));
        const bottom = Math.max(...painted.map((r) => r.y + r.h));
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
    // Whether the scene placed its own <PageHint> (the Stage adds one for page chrome otherwise).
    if (root.querySelector("[data-page-hint]:not([data-auto-page-hint])")) next.__sceneHint = { x: 0, y: 0, w: 0, h: 0 };
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
  // Headers and toolbars (wide and short) are framed as wide as possible.
  const wide = ui.w / Math.max(ui.h, 1) > 5;
  const overview = Math.min(fitUi(wide ? WIDE_OVERVIEW_FILL : OVERVIEW_FILL), MAX_OVERVIEW_SCALE);
  // Page chrome (a header, toolbar or footer: wide and short) reads as such only with the page it
  // frames. When the scene did not add a <PageHint>, the Stage adds the same quiet block: below
  // chrome at the top of the layout, above it otherwise.
  const autoHint =
    wide && !rects.__sceneHint && rects.ui
      ? (() => {
          const w = Math.min(ui.w - 48, 1152);
          const below = ui.y < 400;
          const lum = luminance(background);
          return {
            left: ui.x + (ui.w - w) / 2,
            top: below ? ui.y + ui.h + 32 : ui.y - 32 - 520,
            width: w,
            height: 520,
            background: lum < 0.4 ? "rgba(255,255,255,0.045)" : "rgba(15,23,42,0.045)",
          };
        })()
      : null;

  const framing = (requested: string, click = false) => {
    // A modal or toast is drawn in screen space, already in view at the UI's scale: focusing it
    // would make the camera chase a target that moves with the camera. Keep the UI framing.
    const id = rects[`overlay:${requested}`] ? "ui" : requested;
    const r = rectOf(id);
    // Nudge only when the element is small on screen at overview size.
    const onScreen = Math.min(r.h * overview, (r.w * overview) / 3);
    const nudge = interpolate(onScreen, [36, 110], [MAX_NUDGE, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    // The whole component always stays in frame: a small target gets a light nudge, a click a
    // light lean-in (+15-25%) so its effect reads on a phone, both capped before anything crops.
    const lean = click ? Math.max(nudge, CLICK_NUDGE) : nudge;
    const s = id === "ui" ? overview : Math.max(overview, Math.min(overview * lean, fitUi(MAX_FILL)));
    const halfW = width / (2 * s);
    const halfH = height / (2 * s);
    const axis = (c: number, lo: number, hi: number, half: number) =>
      hi - lo <= 2 * half ? (lo + hi) / 2 : Math.min(Math.max(c, lo + half), hi - half);
    return {
      ls: Math.log(s),
      cx: axis(r.x + r.w / 2, Math.min(ui.x, r.x), Math.max(ui.x + ui.w, r.x + r.w), halfW),
      // Page chrome sits where it lives on a page: a header in the top quarter of the frame, a
      // footer in the bottom quarter, the page (hint) filling the rest.
      cy:
        axis(r.y + r.h / 2, Math.min(ui.y, r.y), Math.max(ui.y + ui.h, r.y + r.h), halfH) +
        (wide ? (ui.y < 400 ? 0.5 : -0.5) * halfH : 0),
    };
  };

  let moments = focus.flatMap((m) => { const k = keyOf(m); return k ? [{ from: m.from, id: k }] : []; });
  // Every click gets a light lean-in toward the clicked control, starting just before the
  // press, so what the click changes (usually right next to it) is readable. Model-declared
  // focus moments on the same target around the same time are replaced by it.
  const clickMoments = (pointer?.clicks ?? []).flatMap((c) => {
    const target = [...(pointer?.path ?? [])].sort((a, b) => a.frame - b.frame).reverse().find((w) => w.frame <= c)?.to;
    const k = target === undefined ? null : keyOf(target);
    return k ? [{ from: Math.max(0, c - 12), id: k, click: true }] : [];
  });
  moments = moments.filter((m) => !clickMoments.some((c) => c.id === m.id && Math.abs(c.from - m.from) < 30));
  const shots: Array<{ from: number; id: string; click?: boolean }> = [{ from: 0, id: "ui" }, ...moments, ...clickMoments].sort(
    (a, b) => a.from - b.from,
  );
  let cam = framing(shots[0].id);
  for (let i = 1; i < shots.length; i++) {
    const a = framing(shots[i - 1].id, shots[i - 1].click);
    const b = framing(shots[i].id, shots[i].click);
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
    // Default text color like a browser on that page: dark on light backgrounds, light on dark
    // ones (components that set no color, e.g. a bare <h1>, must not vanish).
    <AbsoluteFill
      data-fr-freeze=""
      style={{ background, fontFamily, overflow: "hidden", color: luminance(background) < 0.4 ? "#f8fafc" : "#0a0a0a" }}
    >
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
        {autoHint ? (
          <div
            data-page-hint=""
            data-auto-page-hint=""
            style={{ position: "absolute", borderRadius: 16, pointerEvents: "none", ...autoHint }}
          />
        ) : null}
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
