"use client";

import { useEffect, useId, useRef, useState } from "react";
import { INCIDENT_SEVERITIES, type IncidentSeverity } from "@irp/shared";
import type { DailyIncidents } from "@/lib/types";

// Incidents per day, stacked by severity. Severity is ordinal, so it is one
// red hue stepped in lightness (validated for the zinc-900 surface): SEV1 is
// the lightest — most contrast on a dark card — and sits on the baseline.
// Bars: 2px surface gap between segments, rounded top, recessive grid,
// hover tooltip per day, legend above, table view below.
export const SEVERITY_FILL: Record<IncidentSeverity, string> = {
  sev1: "#fca5a5",
  sev2: "#f87171",
  sev3: "#dc2626",
  sev4: "#991b1b",
};

const HEIGHT = 180;
const PAD = { top: 8, right: 4, bottom: 22, left: 26 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const total = (d: DailyIncidents) => d.sev1 + d.sev2 + d.sev3 + d.sev4;
const dayLabel = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T00:00:00Z`).toLocaleDateString([], { ...opts, timeZone: "UTC" });

export function IncidentsChart({ daily }: { daily: DailyIncidents[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipBase = useId();

  const max = Math.max(1, ...daily.map(total));
  const step = max <= 4 ? 1 : max <= 10 ? 2 : 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, daily.length);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(daily.length / Math.max(1, Math.floor(plotW / 64)));

  const hovered = hover === null ? null : daily[hover];

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400" aria-label="Legend">
        {INCIDENT_SEVERITIES.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SEVERITY_FILL[s] }} />
            {s.toUpperCase().replace("SEV", "SEV-")}
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative">
        <svg width={width} height={HEIGHT} role="img" aria-label="Incidents per day by severity" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="#27272a" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-zinc-500 text-[10px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {daily.map((d, i) => {
            const cx = PAD.left + slot * i + slot / 2;
            const x = cx - barW / 2;
            const sum = total(d);
            let acc = 0;
            const clipId = `${clipBase}-${i}`;
            return (
              <g key={d.date}>
                {sum > 0 && (
                  <>
                    <clipPath id={clipId}>
                      {/* Rounded top, square baseline. */}
                      <rect x={x} y={y(sum)} width={barW} height={y(0) - y(sum) + 4} rx={Math.min(4, barW / 2)} />
                    </clipPath>
                    <g clipPath={`url(#${clipId})`} opacity={hover === null || hover === i ? 1 : 0.45}>
                      {INCIDENT_SEVERITIES.map((s) => {
                        const v = d[s];
                        if (!v) return null;
                        const y0 = y(acc);
                        acc += v;
                        const y1 = y(acc);
                        const gap = acc < sum ? 2 : 0; // surface gap above every segment but the top one
                        return <rect key={s} x={x} y={y1 + gap} width={barW} height={Math.max(0, y0 - y1 - gap)} fill={SEVERITY_FILL[s]} />;
                      })}
                    </g>
                  </>
                )}
                {i % labelEvery === 0 && (
                  <text x={cx} y={HEIGHT - 6} textAnchor="middle" className="fill-zinc-500 text-[10px]">
                    {dayLabel(d.date, { month: "short", day: "numeric" })}
                  </text>
                )}
                {/* Hit target: the whole day column, wider than the bar. */}
                <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="#3f3f46" strokeWidth={1} />
        </svg>
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-40 rounded-md border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(0, PAD.left + slot * hover + slot / 2 - 80), Math.max(0, width - 160)) }}
          >
            <p className="mb-1 font-medium text-zinc-100">{dayLabel(hovered.date, { weekday: "short", month: "short", day: "numeric" })}</p>
            {INCIDENT_SEVERITIES.map((s) => (
              <p key={s} className="flex items-center justify-between gap-2 text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: SEVERITY_FILL[s] }} />
                  {s.toUpperCase().replace("SEV", "SEV-")}
                </span>
                <span className="tabular-nums">{hovered[s]}</span>
              </p>
            ))}
            <p className="mt-1 flex justify-between border-t border-zinc-800 pt-1 text-zinc-100">
              <span>Total</span>
              <span className="tabular-nums">{total(hovered)}</span>
            </p>
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-zinc-500">
        <summary className="cursor-pointer select-none hover:text-zinc-300">Table view</summary>
        <div className="mt-2 max-h-48 overflow-y-auto">
          <table className="w-full text-right tabular-nums">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left font-medium">Day</th>
                {INCIDENT_SEVERITIES.map((s) => (
                  <th key={s} className="font-medium">
                    {s.toUpperCase()}
                  </th>
                ))}
                <th className="font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {daily
                .filter((d) => total(d) > 0)
                .map((d) => (
                  <tr key={d.date}>
                    <td className="text-left">{d.date}</td>
                    {INCIDENT_SEVERITIES.map((s) => (
                      <td key={s}>{d[s]}</td>
                    ))}
                    <td>{total(d)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
