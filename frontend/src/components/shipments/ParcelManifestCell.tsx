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
};

/**
 * Parcels listed one row per parcel, each next to the bag it currently
 * sits in. The Bag column only renders when at least one row has a bag.
 */
function ParcelBagList({ rows }: { rows: GroupParcel[] }) {
  const showBags = rows.some((row) => row.bagNumber);
  return (
    <ul className="mt-1 space-y-0.5">
      <li className="flex items-baseline justify-between gap-4 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        <span>Parcels</span>
        {showBags ? <span>Bag</span> : null}
      </li>
      {rows.map((row) => (
        <li key={row.parcelNumber} className="flex items-baseline justify-between gap-4">
          <span className="break-all font-mono text-slate-300">{row.parcelNumber}</span>
          {showBags ? (
            <span className="shrink-0 font-mono text-slate-300">{row.bagNumber ?? "—"}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Hover replacement for native `title` tooltips: a rounded dark card that
 * stays readable for long parcel lists. Fixed-positioned so the table's
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

  const cardWidth = 260;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - cardWidth - 8)) : 0;
  const above = rect ? rect.bottom + 8 + 170 > window.innerHeight && rect.top > 210 : false;

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
          className="fixed z-50 max-h-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-left text-[11px] leading-relaxed text-slate-100 shadow-xl"
        >
          {card}
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
  bagNumbers: string[];
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
 * automatically. Statuses and parcel numbers live in hover cards, with each
 * parcel listed one per line next to the bag it currently sits in.
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
  const awaiting: string[] = [];
  for (const parcel of parcels) {
    if (parcel.scanState === "SCANNED" && parcel.manifestId && parcel.manifestNumber) {
      const group = groups.find((entry) => entry.manifestId === parcel.manifestId);
      if (group) {
        group.parcels.push({ parcelNumber: parcel.parcelNumber, bagNumber: parcel.bagNumber });
        if (parcel.bagNumber && !group.bagNumbers.includes(parcel.bagNumber)) {
          group.bagNumbers.push(parcel.bagNumber);
        }
      } else {
        groups.push({
          manifestId: parcel.manifestId,
          manifestNumber: parcel.manifestNumber,
          manifestStatus: parcel.manifestStatus,
          parcels: [{ parcelNumber: parcel.parcelNumber, bagNumber: parcel.bagNumber }],
          bagNumbers: parcel.bagNumber ? [parcel.bagNumber] : []
        });
      }
    } else {
      awaiting.push(parcel.parcelNumber);
    }
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
                <ParcelBagList rows={group.parcels} />
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
              <ParcelBagList rows={awaiting.map((parcelNumber) => ({ parcelNumber, bagNumber: null }))} />
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
