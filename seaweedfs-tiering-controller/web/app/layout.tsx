import "./globals.css";
import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { themeBootScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "SeaweedFS Tiering Console",
  description: "AI-assisted data tiering for SeaweedFS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: themeBootScript mutates data-theme
    // synchronously before React hydrates, which would otherwise trip
    // React's "server/client mismatch" warning.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline so it runs before paint — sets data-theme from
            localStorage and avoids the white→dark (or dark→white)
            flash on first load. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
