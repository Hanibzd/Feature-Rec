import React from "react";

/** Render-time stand-in for next/image: a plain img (remote sources are blocked by the sandbox). */
export default function Image({ src, alt, width, height, fill, priority: _priority, ...rest }: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | { src: string }; fill?: boolean; priority?: boolean }) {
  return (
    <img
      src={typeof src === "string" ? src : src.src}
      alt={alt}
      width={width}
      height={height}
      style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } : undefined}
      {...rest}
    />
  );
}
