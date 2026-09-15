"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShipmentListItem } from "@/lib/shipmentsList";

type ParcelManifest = NonNullable<ShipmentListItem["parcelManifests"]>[number];

function manifestStatusLabel(status: ParcelManifest["manifestStatus"]) {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "PACKING":
      return "Packing";
    case "READY_TO_SEAL":
      return "Ready to seal";
    case "SEALED":
      return "Sealed";
    case "DISPATCHED":
      return "Dispatched";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "In manifest";
  }
}

type GroupParcel = {
  parcelNumber: string;
  bagNumber: string | null;
  weightKg: number | null;
};

function formatParcelWeight(value: number) {
  return `${Number(value.toFixed(2))} kg`;
}

type ParcelRow = {
  parcelNumber: string;
  weightKg: number | null;
  /** Where the parcel sits: its bag, its manifest run, or "Awaiting". */
  status: string;
};

/**
 * Every parcel of the shipment, one row per parcel, so a manifest holding
 * only 1 of 2 parcels still shows where the other one is. Grid columns keep
 * number, weight and status aligned no matter how long a parcel number runs.
 */
function ParcelStatusList({ rows }: { rows: ParcelRow[] }) {
  const showWeight = rows.some((row) => row.weightKg != null);
  const columns = showWeight ? "minmax(0,1fr) auto auto" : "minmax(0,1fr) auto";
  return (
    <ul className="mt-1.5 space-y-1">
      <li
        style={{ gridTemplateColumns: columns }}
        className="grid items-baseline gap-3 text-[10px] font-semibold uppercase tracking-wide text-slate-400"
      >
        <span>Parcels</span>
        {showWeight ? <span>Weight</span> : null}
        <span className="text-right">Status</span>
      </li>
      {rows.map((row) => (
        <li
          key={row.parcelNumber}
          style={{ gridTemplateColumns: columns }}
          className="grid items-baseline gap-3"
        >
          <span className="min-w-0 break-all font-mono text-slate-300">
            {row.parcelNumber}
          </span>
          {showWeight ? (
            <span className="shrink-0 tabular-nums text-slate-300">
              {row.weightKg != null ? formatParcelWeight(row.weightKg) : "—"}
            </span>
          ) : null}
          <span className="shrink-0 text-right text-slate-300">
            {row.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hover replacement for native `title` tooltips: a rounded dark chatbox card
 * with an arrow pointing back at the cell. Fixed-positioned so the table's
 * horizontal scroll never clips it; dismissed on any scroll, resize, or
 * pointer leave. Tap toggles it for touch screens.
 */
function HoverCard({ label, card, children }: { label: string; card: ReactNode; children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const open = rect !== null;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setRect(null);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open ]);

  const show = () => setRect(anchorRef.current?.getBoundingClientRect() ?? null);
  const hide = () => setRect(null);

  const cardWidth = 300;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - cardWidth - 8)) : 0;
  const above = rect ? rect.bottom + 8 + 200 > window.innerHeight && rect.top > 240 : false;
  // Arrow tracks the anchor's centre, clamped inside the card.
  const arrowLeft = rect ? Math.min(Math.max(rect.left + rect.width / 2 - left, 16), cardWidth - 16) : 16;

  return (
    <span
      ref={anchorRef}
      aria-label={label}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={() => (open ? hide() : show())}
      className="inline-flex min-w-0 cursor-default outline-none"
    >
      {children}
      {open && rect ? (
        <span
          role="tooltip"
          style={{
            left,
            top: above ? rect.top - 8 : rect.bottom + 8,
            transform: above ? "translateY(-100%)" : undefined,
            width: cardWidth
          }}
          className="fixed z-50"
        >
          <span
            aria-hidden="true"
            style={{ left: arrowLeft }}
            className={`absolute h-2.5 w-2.5 rotate-45 border-slate-700 bg-slate-900 ${
              above ? "-bottom-[5px] border-b border-r" : "-top-[5px] border-l border-t"
            }`}
          />
          <span className="block max-h-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-3 text-left text-[11px] leading-relaxed text-slate-100 shadow-xl">
            {card}
          </span>
        </span>
      ) : null}
    </span>
  );
}

type ManifestGroup = {
  manifestId: string;
  manifestNumber: string;
  manifestStatus: ParcelManifest["manifestStatus"];
  parcels: GroupParcel[];
};

/**
 * Staff-only parcel scan state for one shipments-table row.
 *
 * Each operational manifest holding the shipment's parcels shows its run
 * number with the scanned count over the shipment total:
 * `Manifest: SLC029` / `Parcels: 1/6`. Nothing scanned yet reads as plain
 * text ("Awaiting Scan" with its count stacked below). A parcel
 * counts as scanned only while a live `ACCEPTED` scan owns it; removals
 * (parcel/bag/manifest) flip that row to `REMOVED`, so the count drops back
 * automatically. Hover cards list every parcel of the shipment with its
 * weight and where it sits, so a manifest holding 1 of 2 parcels still shows
 * the other one as awaiting or under its own run.
 */
export default function ParcelManifestCell({ shipment }: { shipment: ShipmentListItem }) {
  // During a staggered deployment the backend may not send `parcelManifests`
  // yet. Fall back to the shipment's parcel numbers as awaiting rather than
  // claiming labels were never issued.
  const parcels: ParcelManifest[] = shipment.parcelManifests
    ?? shipment.awbNumbers.map((parcelNumber) => ({
      parcelNumber,
      scanState: "AWAITING_SCAN" as const,
      manifestId: null,
      manifestNumber: null,
      manifestStatus: null,
      bagNumber: null,
      scannedAt: null
    }));

  const total = parcels.length;
  if (!total) {
    return <span className="text-slate-400">Awaiting booking</span>;
  }

  const groups: ManifestGroup[] = [];
  const awaiting: GroupParcel[] = [];
  for (const parcel of parcels) {
    if (parcel.scanState === "SCANNED" && parcel.manifestId && parcel.manifestNumber) {
      const group = groups.find((entry) => entry.manifestId === parcel.manifestId);
      if (group) {
        group.parcels.push({ parcelNumber: parcel.parcelNumber, bagNumber: parcel.bagNumber, weightKg: parcel.weightKg ?? null });
      } else {
        groups.push({
          manifestId: parcel.manifestId,
          manifestNumber: parcel.manifestNumber,
          manifestStatus: parcel.manifestStatus,
          parcels: [{ parcelNumber: parcel.parcelNumber, bagNumber: parcel.bagNumber, weightKg: parcel.weightKg ?? null }]
        });
      }
    } else {
      awaiting.push({ parcelNumber: parcel.parcelNumber, bagNumber: null, weightKg: parcel.weightKg ?? null });
    }
  }

  const ownerByParcel = new Map<string, ManifestGroup>();
  for (const group of groups) {
    for (const parcel of group.parcels) ownerByParcel.set(parcel.parcelNumber, group);
  }

  // Every parcel of the shipment, with where it sits: its bag when packed,
  // otherwise its manifest run, otherwise awaiting. No row is emphasized;
  // the tooltip header already names the manifest in focus.
  function statusRows(focus: ManifestGroup | null): ParcelRow[] {
    return parcels.map((parcel) => {
      const owner = ownerByParcel.get(parcel.parcelNumber);
      if (focus && owner?.manifestId === focus.manifestId) {
        const bag = focus.parcels.find((entry) => entry.parcelNumber === parcel.parcelNumber)?.bagNumber;
        return {
          parcelNumber: parcel.parcelNumber,
          weightKg: parcel.weightKg ?? null,
          status: bag ?? focus.manifestNumber
        };
      }
      if (owner) {
        return {
          parcelNumber: parcel.parcelNumber,
          weightKg: parcel.weightKg ?? null,
          status: owner.manifestNumber
        };
      }
      return {
        parcelNumber: parcel.parcelNumber,
        weightKg: parcel.weightKg ?? null,
        status: "Awaiting"
      };
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {groups.map((group) => {
        return (
          <HoverCard
            key={group.manifestId}
            label={`${group.parcels.length} of ${total} parcels scanned into manifest ${group.manifestNumber}`}
            card={
              <>
                <p className="font-bold text-white">
                  {group.manifestNumber} · {manifestStatusLabel(group.manifestStatus)}
                </p>
                <p className="mt-0.5 text-slate-300">
                  {group.parcels.length} of {total} parcels
                </p>
                <ParcelStatusList rows={statusRows(group)} />
              </>
            }
          >
            <span className="flex min-w-0 flex-col gap-0.5 text-xs">
              <span className="whitespace-nowrap">
                <span className="text-slate-500">Manifest: </span>
                <Link
                  href={`/dashboard/operations-manifests/${group.manifestId}`}
                  className="font-semibold text-[#0D1282] hover:underline"
                >
                  {group.manifestNumber}
                </Link>
              </span>
              <span className="whitespace-nowrap">
                <span className="text-slate-500">Parcels: </span>
                <span className="font-bold tabular-nums text-slate-700">
                  {group.parcels.length}/{total}
                </span>
              </span>
            </span>
          </HoverCard>
        );
      })}
      {!groups.length && awaiting.length ? (
        <HoverCard
          label={`${awaiting.length} of ${total} parcels awaiting scan`}
          card={
            <>
              <p className="font-bold text-white">Awaiting Scan</p>
              <p className="mt-0.5 text-slate-300">
                {awaiting.length} of {total} parcels · Not currently scanned into any operational manifest.
              </p>
              <ParcelStatusList rows={statusRows(null)} />
            </>
          }
        >
          <span className="flex min-w-0 flex-col gap-0.5 text-xs">
            <span className="font-semibold text-slate-600">Awaiting Scan</span>
            <span className="font-bold tabular-nums text-slate-500">
              {awaiting.length}/{total}
            </span>
          </span>
        </HoverCard>
      ) : null}
    </div>
  );
}
