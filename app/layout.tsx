import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tacobot",
  description: "Internal recognition program for wlt-and-shaman",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
