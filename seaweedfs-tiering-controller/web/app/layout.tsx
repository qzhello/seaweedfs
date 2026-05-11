import "./globals.css";
import type { Metadata } from "next";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "SeaweedFS Tiering Console",
  description: "AI-assisted data tiering for SeaweedFS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
