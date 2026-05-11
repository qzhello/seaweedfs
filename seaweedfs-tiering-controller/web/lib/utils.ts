import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function bytes(n: number | undefined | null): string {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(Math.floor(Math.log2(n) / 10), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i ? 2 : 0)} ${u[i]}`;
}

export function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export function relTime(d: string | Date) {
  const t = typeof d === "string" ? new Date(d) : d;
  const s = (Date.now() - t.getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
