import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Acme",
  description: "Acme product — settings",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
