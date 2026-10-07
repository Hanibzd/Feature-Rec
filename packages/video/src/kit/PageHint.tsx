import React from "react";

/**
 * A quiet placeholder for "the rest of the page", so page chrome (header, nav bar,
 * footer, sidebar) reads as such. Deliberately abstract: one soft block, no text, no fake
 * content. Place it OUTSIDE data-focus="ui" (it is context, not the change).
 */
export const PageHint: React.FC<{
  tone?: "light" | "dark";
  /** Block height in px (width follows the parent). */
  height?: number;
  /** Max width of the page content column, like the product's container. */
  maxWidth?: number;
  /** Space between the chrome and the block. */
  gap?: number;
}> = ({ tone = "light", height = 520, maxWidth = 1152, gap = 32 }) => (
  <div data-page-hint="" style={{ width: "100%", boxSizing: "border-box", maxWidth, margin: `${gap}px auto 0`, padding: "0 24px" }}>
    <div
      style={{
        height,
        borderRadius: 16,
        background: tone === "dark" ? "rgba(255,255,255,0.045)" : "rgba(15,23,42,0.045)",
      }}
    />
  </div>
);
