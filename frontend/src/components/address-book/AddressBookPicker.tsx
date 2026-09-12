"use client";

import { useEffect, useState } from "react";
import { FiMapPin, FiSearch, FiStar, FiX } from "react-icons/fi";
import {
  listAddressBookEntries,
  prepareAddressBookEntryForShipment,
  type AddressBookEntry,
  type AddressBookSelection,
  type AddressBookEntryType
} from "@/lib/addressBook";

export default function AddressBookPicker({
  open,
  businessAccountId,
  type,
  onClose,
  onSelect
}: {
  open: boolean;
  businessAccountId: string;
  type: AddressBookEntryType;
  onClose: () => void;
  onSelect: (entry: AddressBookSelection) => void;
}) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectingId, setSelectingId] = useState("");

  async function selectEntry(entry: AddressBookEntry) {
    if (selectingId) return;
    setSelectingId(entry.id);
    setError("");
    try {
      const selection = await prepareAddressBookEntryForShipment(entry);
      setSearch("");
      onSelect(selection);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The saved address could not be applied.");
    } finally {
      setSelectingId("");
    }
  }

  useEffect(() => {
    if (!open || !businessAccountId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void listAddressBookEntries({ businessAccountId, type, search, limit: 100 })
        .then((result) => { if (active) setEntries(result.entries); })
        .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Unable to load saved addresses."); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [businessAccountId, open, search, type]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-70 flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label={`Choose saved ${type.toLowerCase()} address`}>
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold text-[#0D1282]">Choose Saved {type === "SENDER" ? "Sender" : "Recipient"}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {type === "SENDER" ? "Contact, address and saved Aadhaar details will be filled." : "Contact and address details will be filled."}
            </p>
          </div>
          <button type="button" onClick={() => { setSearch(""); onClose(); }} aria-label="Close address book" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:border-[#0D1282] hover:text-[#0D1282]">
            <FiX className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-slate-200 p-4 sm:px-6">
          <label className="relative block">
            <FiSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search label, contact, city or postcode" className="h-11 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10" autoFocus />
          </label>
        </div>
        <div className="min-h-48 flex-1 overflow-y-auto p-4 [scrollbar-width:thin] sm:p-6">
          {error ? <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p> : null}
          {loading ? <p className="py-12 text-center text-sm font-medium text-slate-500">Loading saved addresses...</p> : null}
          {!loading && !error && !entries.length ? (
            <div className="py-12 text-center">
              <FiMapPin className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-3 text-sm font-semibold text-slate-700">No saved {type.toLowerCase()} addresses found.</p>
              <p className="mt-1 text-sm text-slate-500">Add one from Address Book, then return to this shipment.</p>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void selectEntry(entry)}
                disabled={Boolean(selectingId)}
                className="group rounded-2xl border border-slate-200 p-4 text-left transition hover:border-[#0D1282] hover:bg-[#0D1282]/[0.03] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/20 disabled:cursor-wait disabled:opacity-60"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-950">{entry.label}</span>
                    <span className="mt-1 block truncate text-xs font-medium text-slate-500">{entry.contactName}</span>
                  </span>
                  {entry.isFavourite ? <FiStar className="h-4 w-4 shrink-0 fill-[#F0DE36] text-[#b49c00]" /> : null}
                </span>
                <span className="mt-3 block text-sm leading-5 text-slate-600">
                  {[entry.addressLine1, entry.addressLine2, entry.townOrCity, entry.postcode].filter(Boolean).join(", ")}
                </span>
                <span className="mt-3 block text-xs font-semibold text-[#0D1282] group-hover:underline">
                  {selectingId === entry.id ? "Applying..." : "Use this address"}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
