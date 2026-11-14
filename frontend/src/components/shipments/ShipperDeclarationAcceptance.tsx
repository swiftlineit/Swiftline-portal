"use client";

import { useState } from "react";
import Link from "next/link";

type ShipperDeclarationAcceptanceProps = {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

const declarationItems = [
  {
    heading: "Accuracy of Information:",
    text: "All shipment details, including contents, description, quantity, declared value, sender and receiver information, are true, accurate, and complete."
  },
  {
    heading: "Responsibility for Contents:",
    text: "I acknowledge that I am responsible for the legality, accuracy, authenticity, and proper declaration of all items contained in the shipment."
  },
  {
    heading: "Prohibited & Restricted Items:",
    text: "I confirm that the shipment does not contain any prohibited, illegal, hazardous, or restricted items unless specifically permitted and declared in accordance with applicable regulations."
  },
  {
    heading: "Customs & Regulatory Compliance:",
    text: "I accept responsibility for providing accurate documentation and complying with applicable customs, import, export, and destination-country regulations, including any duties, taxes, penalties, or charges legally payable by me."
  },
  {
    heading: "Inspection & Verification:",
    text: "I acknowledge that Swiftline, its authorized logistics partners, airlines, and regulatory authorities may inspect, verify, hold, or refuse shipments in accordance with applicable laws and service conditions."
  },
  {
    heading: "Liability & Acceptance:",
    text: "I understand that any false declaration, misrepresentation, or non-compliance may result in shipment delays, seizure, penalties, or additional charges. I accept responsibility for consequences arising from my inaccurate declarations or violations, subject to applicable law."
  }
] as const;

export function ShipperDeclarationAcceptance({
  checked,
  disabled = false,
  onCheckedChange
}: ShipperDeclarationAcceptanceProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-800">
      <div className="flex items-start gap-2">
        <input
          id="shipper-declaration-acceptance"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange(event.currentTarget.checked)}
          className="mt-0.5 size-4 shrink-0 accent-blue-900 disabled:cursor-not-allowed"
        />
        <div className="min-w-0 text-xs leading-5">
          <label htmlFor="shipper-declaration-acceptance" className="cursor-pointer">
            I confirm that I have read and accepted the shipper declaration.
          </label>{" "}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="shipper-declaration-details"
            className="inline font-semibold text-blue-900 underline underline-offset-2 hover:text-blue-700"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Read less" : "read more..."}
          </button>
        </div>
      </div>
      <div id="shipper-declaration-details" hidden={!expanded} role="region" aria-label="Full shipper declaration" className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5">
        <h3 className="font-semibold uppercase tracking-wide">SHIPPER’S DECLARATION &amp; ACCEPTANCE</h3>
        <p className="mt-1 font-medium">Swiftline Cargo &amp; Express Logistics Pvt. Ltd.</p>
        <p className="mt-2">By proceeding with this shipment booking, I hereby declare and confirm that:</p>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          {declarationItems.map((item) => (
            <li key={item.heading}>
              <strong>{item.heading}</strong> {item.text}
            </li>
          ))}
        </ol>
        <p className="mt-3">
          By selecting “I Agree &amp; Continue,” I confirm that I have read, understood, and accepted this declaration and Swiftline’s <Link href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-900 underline underline-offset-2 hover:text-blue-700">applicable Terms &amp; Conditions</Link>.
        </p>
        <p className="mt-2 font-semibold">Every Parcel a Promise, Swiftly Delivered.</p>
      </div>
    </section>
  );
}
