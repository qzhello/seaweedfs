// Lightweight breadcrumb trail for detail pages. Renders chevron-separated
// links so deep pages (cluster/volume/execution detail) keep their parent
// list one click away and orient users who arrive via direct URL.
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;     // when present the crumb is a Link; otherwise plain text
}

interface BreadcrumbProps {
  items: Crumb[];
  className?: string;
}

export function Breadcrumb({ items, className = "" }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1 text-xs text-muted ${className}`}>
      {items.map((it, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            {it.href && !isLast ? (
              <Link href={it.href} className="hover:text-text transition-colors">{it.label}</Link>
            ) : (
              <span className={isLast ? "text-text font-medium" : ""}>{it.label}</span>
            )}
            {!isLast && <ChevronRight size={12} className="text-muted/50"/>}
          </span>
        );
      })}
    </nav>
  );
}
