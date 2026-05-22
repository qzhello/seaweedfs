"use client";

// Reusable form primitives that combine guided pickers (datalist combos,
// sliders, duration steppers) with free text so the operator never has
// to memorise a flag value, but can always override.
//
// Used by the EC encode / decode / plan dialogs and reusable elsewhere.

import { useId, useMemo } from "react";
import { useT } from "@/lib/i18n";

// ─────────── Combo (input + datalist suggestions) ────────────
//
// Behaves like a normal <input>, but pops the cluster's actual values
// (collections / disk types / etc.) as autocomplete. Operators can pick
// from the list OR type anything (so weird custom diskTypes still work).
export function ComboInput({
  value, onChange, options, placeholder, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const cleaned = useMemo(
    () => Array.from(new Set(options.filter(Boolean))).sort(),
    [options],
  );
  return (
    <>
      <input
        list={id}
        className="input text-sm w-full"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
      <datalist id={id}>
        {cleaned.map(o => <option key={o} value={o}/>)}
      </datalist>
    </>
  );
}

// ─────────── Number slider with input ────────────
//
// Range slider on top, numeric input + unit suffix on the right. Both
// stay in sync. Clamped to [min, max] on the input side so operators
// can't sneak past the safe range. `step` controls slider granularity.
export function NumberSlider({
  value, onChange, min, max, step = 1, suffix, hint,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hint?: string;
}) {
  const numeric = typeof value === "number" && !Number.isNaN(value);
  const display = numeric ? String(value) : "";
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          className="flex-1 accent-accent"
          min={min} max={max} step={step}
          value={numeric ? value : min}
          onChange={e => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          className="input text-sm w-20 text-right tabular-nums"
          min={min} max={max} step={step}
          value={display}
          onChange={e => {
            const s = e.target.value;
            if (s === "") { onChange(""); return; }
            const n = Number(s);
            if (Number.isNaN(n)) return;
            onChange(Math.min(max, Math.max(min, n)));
          }}
        />
        {suffix && <span className="text-xs text-muted shrink-0">{suffix}</span>}
      </div>
      {hint && <span className="block text-[10px] text-muted/70 mt-0.5">{hint}</span>}
    </div>
  );
}

// ─────────── Duration picker (number + unit dropdown) ────────────
//
// Shell durations look like "30m" / "1h" / "2d". We split them into a
// number + a unit pick so the operator never types `1H` (uppercase) or
// `1hour` (invalid) by mistake. Output stays in the canonical form.
const DURATION_UNITS = [
  { unit: "s", label: "seconds" },
  { unit: "m", label: "minutes" },
  { unit: "h", label: "hours" },
] as const;
type DurationUnit = (typeof DURATION_UNITS)[number]["unit"];

export function DurationPicker({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useT();
  const { num, unit } = parseDuration(value);
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        className="input text-sm w-24 text-right tabular-nums"
        min={0}
        value={Number.isNaN(num) ? "" : num}
        onChange={e => onChange(`${e.target.value || "0"}${unit}`)}
      />
      <select
        className="select text-sm py-1 px-2"
        value={unit}
        onChange={e => onChange(`${Number.isNaN(num) ? 0 : num}${e.target.value}`)}>
        {DURATION_UNITS.map(u => (
          <option key={u.unit} value={u.unit}>{t(u.label)}</option>
        ))}
      </select>
    </div>
  );
}

function parseDuration(s: string): { num: number; unit: DurationUnit } {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([smh])$/);
  if (m) {
    return { num: parseFloat(m[1]), unit: m[2] as DurationUnit };
  }
  // Fall back: try to coerce a bare number as seconds.
  const n = parseFloat(s);
  return { num: Number.isNaN(n) ? NaN : n, unit: "m" };
}

// ─────────── Field wrapper ────────────
export function Field({ label, hint, children }: {
  label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="block text-[10px] text-muted/70 mt-0.5">{hint}</span>}
    </label>
  );
}
