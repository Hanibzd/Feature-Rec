import React, { useContext } from "react";
import { createPortal } from "react-dom";
import { StageContext } from "./Stage";

/**
 * Anything that covers the screen in the real product: dialog, drawer, toast.
 * Rendered in screen space (not inside the zoomed page), so the backdrop always covers the
 * whole frame, while the content keeps the same scale as the UI. Pointer targets
 * (data-focus) inside work like anywhere else.
 * Never use position: fixed in a scene — it only covers the page box, not the screen.
 */
export const Modal: React.FC<{
  /** 0 = closed, 1 = open (use useProgress). */
  open: number;
  placement?: "center" | "right" | "bottom-right";
  /** Backdrop darkness at full open; defaults to 0.4 (0 for toasts). */
  dim?: number;
  children: React.ReactNode;
}> = ({ open, placement = "center", dim, children }) => {
  const { overlay, scale } = useContext(StageContext);
  if (!overlay) return null;
  const backdrop = dim ?? (placement === "bottom-right" ? 0 : 0.4);

  const content: React.CSSProperties =
    placement === "center"
      ? {
          left: "50%",
          top: "50%",
          transform: `translate(-50%, -50%) scale(${scale * (0.98 + 0.02 * open)})`,
          transformOrigin: "center",
        }
      : placement === "right"
        ? {
            right: 0,
            top: 0,
            height: `${100 / scale}%`,
            transform: `translateX(${(1 - open) * 100}%) scale(${scale})`,
            transformOrigin: "top right",
          }
        : {
            right: 40,
            bottom: 40,
            transform: `translateY(${(1 - open) * 12}px) scale(${scale})`,
            transformOrigin: "bottom right",
          };

  return createPortal(
    <>
      <div style={{ position: "absolute", inset: 0, background: `rgba(9,9,11,${backdrop * open})` }} />
      <div style={{ position: "absolute", opacity: placement === "right" ? 1 : open, ...content }}>{children}</div>
    </>,
    overlay,
  );
};
