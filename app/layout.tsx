import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pytc_glancer — PyTorch Connectomics",
  description: "Organize permanent Neuroglancer views into studies.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
