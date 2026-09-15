"use client";

import { useState } from "react";
import type { StageCount, TrendPoint } from "@/lib/dashboardOverview";

const stageColors = [
  { base: "#26359A", hover: "#1E2B86" },
  { base: "#243294", hover: "#1C297F" },
  { base: "#222F8E", hover: "#1A2679" },
  { base: "#202C88", hover: "#182373" },
  { base: "#1D2982", hover: "#16206D" },
  { base: "#1A267C", hover: "#131D67" },
  { base: "#172276", hover: "#111A61" },
  { base: "#0D1282", hover: "#090D69" },
];

const exceptionColors = {
  warning: { base: "#76530F", hover: "#60430B" },
  serious: { base: "#813C31", hover: "#6B3027" },
  critical: { base: "#922E3A", hover: "#792530" },
} as const;

function stageColor(stage: StageCount, hovered = false) {
  if (stage.tone === "stage") {
    const color =
      stageColors[Math.min(stage.step, stageColors.length - 1)];

    return hovered ? color.hover : color.base;
  }

  const color = exceptionColors[stage.tone];
  return hovered ? color.hover : color.base;
}

function share(count: number, total: number) {
  if (!total || !count) return "0%";

  const value = (count / total) * 100;
  return value < 0.5 ? "<1%" : `${Math.round(value)}%`;
}

function formatAxisCount(value: number) {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }

  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }

  return value.toLocaleString();
}

function formatFullCount(value: number) {
  return value.toLocaleString();
}

function axisScale(peak: number) {
  const target = Math.max(peak, 4);
  const rough = target / 5;
  const power = 10 ** Math.floor(Math.log10(rough));

  const multipliers =
    power >= 10
      ? [1, 2, 2.5, 5, 10]
      : [1, 2, 5, 10];

  const step = Math.max(
    1,
    multipliers
      .map((multiple) => multiple * power)
      .find((candidate) => candidate >= rough) ??
      10 * power,
  );

  let top = Math.ceil(target / step) * step;

  if (top - target < step / 2) {
    top += step;
  }

  const gridTicks: number[] = [];

  for (let value = top; value > 0; value -= step) {
    gridTicks.push(value);
  }

  return {
    top,
    gridTicks,
    ticks: [...gridTicks, 0],
  };
}

// ── pipeline ──────────────────────────────────────────────────────────────────

export function StagePipelineChart({
  stages,
  unitLabel,
  dimmed = false,
}: {
  stages: StageCount[];
  unitLabel: string;
  dimmed?: boolean;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const total = stages.reduce(
    (sum, stage) => sum + stage.count,
    0,
  );

  const peak = Math.max(
    ...stages.map((stage) => stage.count),
    1,
  );

  const scale = axisScale(peak);

  return (
    <div
      className={`transition-opacity duration-200 ${
        dimmed ? "opacity-55" : "opacity-100"
      }`}
    >
      <div className="overflow-x-auto pb-1">
        <div className="min-w-180 px-1">
          <div className="flex">
            <div
              aria-hidden="true"
              className="relative h-67.5 w-11 shrink-0"
            >
              {scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-2 -translate-y-1/2 text-[10px] font-medium leading-none tabular-nums text-slate-400"
                  style={{
                    top: `${((scale.top - tick) / scale.top) * 100}%`,
                  }}
                >
                  {formatAxisCount(tick)}
                </span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-67.5"
              >
                {scale.gridTicks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute inset-x-0 h-px bg-slate-200/70"
                    style={{
                      top: `${((scale.top - tick) / scale.top) * 100}%`,
                    }}
                  />
                ))}

                <span className="absolute inset-x-0 bottom-0 h-px bg-slate-200" />
              </div>

              <div
                className="relative grid h-67.5 items-end gap-4 px-2"
                style={{
                  gridTemplateColumns: `repeat(${stages.length}, minmax(58px, 1fr))`,
                }}
              >
                {stages.map((stage) => {
                  const active = activeKey === stage.key;

                  const height = stage.count
                    ? Math.max((stage.count / scale.top) * 100, 3)
                    : 0;

                  const tooltipInside = height >= 76;

                  return (
                    <div
                      key={stage.key}
                      tabIndex={0}
                      aria-label={`${stage.label}: ${stage.count} ${unitLabel}, ${share(
                        stage.count,
                        total,
                      )} of total`}
                      onPointerEnter={() => setActiveKey(stage.key)}
                      onPointerLeave={() => setActiveKey(null)}
                      onFocus={() => setActiveKey(stage.key)}
                      onBlur={() => setActiveKey(null)}
                      className="group relative flex h-full min-w-0 items-end justify-center outline-none"
                    >
                      {active ? (
                        <div
                          className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2"
                          style={{
                            bottom: tooltipInside
                              ? `calc(${height}% - 54px)`
                              : `calc(${height}% + 10px)`,
                          }}
                        >
                          <div className="relative whitespace-nowrap rounded bg-[#070B24] px-3 py-2 shadow-[0_10px_28px_-8px_rgba(7,11,36,0.55)]">
                            <div className="flex items-baseline justify-center gap-1.5">
                              <span className="text-[13px] font-semibold tabular-nums text-white">
                                {formatFullCount(stage.count)}
                              </span>

                              <span className="text-[10px] font-medium text-slate-300">
                                {unitLabel}
                              </span>
                            </div>

                            <p className="mt-0.5 text-center text-[10px] font-medium tabular-nums text-slate-400">
                              {share(stage.count, total)} of total
                            </p>

                            {!tooltipInside ? (
                              <span className="absolute left-1/2 top-full -translate-x-1/2 border-x-[5px] border-t-[5px] border-x-transparent border-t-[#070B24]" />
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <div
                        className={`w-full max-w-15 rounded-t transition-all duration-200 ${
                          active
                            ? "-translate-y-0.5 shadow-[0_10px_24px_-11px_rgba(13,18,130,0.6)]"
                            : "shadow-[0_4px_12px_-9px_rgba(13,18,130,0.28)]"
                        }`}
                        style={{
                          height: `${height}%`,
                          backgroundColor: stageColor(stage, active),
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              <div
                className="mt-3 grid gap-4 px-2"
                style={{
                  gridTemplateColumns: `repeat(${stages.length}, minmax(58px, 1fr))`,
                }}
              >
                {stages.map((stage) => {
                  const active = activeKey === stage.key;

                  return (
                    <div key={stage.key} className="min-w-0 text-center">
                      <p
                        title={stage.label}
                        className={`line-clamp-2 min-h-7 text-[10px] font-medium leading-3.5 transition-colors ${
                          active ? "text-slate-900" : "text-slate-500"
                        }`}
                      >
                        {stage.label}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── daily trend ───────────────────────────────────────────────────────────────

export function DailyTrendChart({
  points,
  unitLabel,
  dimmed = false,
}: {
  points: TrendPoint[];
  unitLabel: string;
  dimmed?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const peak = Math.max(
    ...points.map((point) => point.count),
    1,
  );

  const scale = axisScale(peak);

  return (
    <div
      className={`transition-opacity duration-200 ${
        dimmed ? "opacity-55" : "opacity-100"
      }`}
    >
      <div className="overflow-x-auto pb-1">
        <div className="min-w-170 px-1">
          <div className="flex">
            <div
              aria-hidden="true"
              className="relative h-65 w-11 shrink-0"
            >
              {scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-2 -translate-y-1/2 text-[10px] font-medium leading-none tabular-nums text-slate-400"
                  style={{
                    top: `${((scale.top - tick) / scale.top) * 100}%`,
                  }}
                >
                  {formatAxisCount(tick)}
                </span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-65"
              >
                {scale.gridTicks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute inset-x-0 h-px bg-slate-200/70"
                    style={{
                      top: `${((scale.top - tick) / scale.top) * 100}%`,
                    }}
                  />
                ))}

                <span className="absolute inset-x-0 bottom-0 h-px bg-slate-200" />
              </div>

              <div className="relative flex h-65 items-end gap-1.5 px-2">
                {points.map((point, index) => {
                  const active = activeIndex === index;

                  const height = point.count
                    ? Math.max((point.count / scale.top) * 100, 3)
                    : 0;

                  const tooltipInside = height >= 76;

                  return (
                    <div
                      key={point.key}
                      tabIndex={0}
                      aria-label={`${point.caption}: ${point.count} ${unitLabel}`}
                      onPointerEnter={() => setActiveIndex(index)}
                      onPointerLeave={() => setActiveIndex(null)}
                      onFocus={() => setActiveIndex(index)}
                      onBlur={() => setActiveIndex(null)}
                      className="group relative flex h-full min-w-13 flex-1 items-end justify-center outline-none"
                    >
                      {active ? (
                        <div
                          className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2"
                          style={{
                            bottom: tooltipInside
                              ? `calc(${height}% - 52px)`
                              : `calc(${height}% + 10px)`,
                          }}
                        >
                          <div className="relative whitespace-nowrap rounded-lg bg-[#070B24] px-3 py-2 shadow-[0_10px_28px_-8px_rgba(7,11,36,0.55)]">
                            <div className="flex items-baseline justify-center gap-1.5">
                              <span className="text-[13px] font-semibold tabular-nums text-white">
                                {formatFullCount(point.count)}
                              </span>

                              <span className="text-[10px] font-medium text-slate-300">
                                {unitLabel}
                              </span>
                            </div>

                            <p className="mt-0.5 text-center text-[10px] font-medium text-slate-400">
                              {point.caption}
                            </p>

                            {!tooltipInside ? (
                              <span className="absolute left-1/2 top-full -translate-x-1/2 border-x-[5px] border-t-[5px] border-x-transparent border-t-[#070B24]" />
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <div
                        className={`w-full max-w-16 rounded-t-lg transition-all duration-200 ${
                          active
                            ? "-translate-y-0.5 bg-[#090D69] shadow-[0_10px_24px_-11px_rgba(13,18,130,0.65)]"
                            : "bg-[#0D1282] shadow-[0_4px_12px_-9px_rgba(13,18,130,0.3)]"
                        }`}
                        style={{
                          height: `${height}%`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex gap-1.5 px-2">
                {points.map((point, index) => {
                  const active = activeIndex === index;

                  return (
                    <div
                      key={point.key}
                      className="min-w-13 flex-1 text-center"
                    >
                      <span
                        className={`text-[9px] font-medium tabular-nums transition-colors ${
                          active ? "text-slate-900" : "text-slate-500"
                        }`}
                        title={point.caption}
                      >
                        {point.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}