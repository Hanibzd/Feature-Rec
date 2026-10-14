import React from "react";

/** Render-time stand-in for next/link: a plain anchor (navigation is disabled in renders). */
export default function Link({ href, children, ...rest }: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string } }) {
  return (
    <a href={typeof href === "string" ? href : (href.pathname ?? "#")} {...rest}>
      {children}
    </a>
  );
}
