"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiMapPin, FiPlus, FiTruck } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  listPickupCourierAddresses,
  pickupTransportCompanies,
  savePickupCourierAddress,
  type PickupAddress,
  type PickupCourierAddress,
  type PickupCourierBranch,
} from "@/lib/pickups";

const emptyAddress: PickupAddress = {
  addressLine1: "", addressLine2: "", townOrCity: "", county: "", postcode: "",
  countryCode: "IN", countryName: "India", googlePlaceId: "",
};
const fieldClass = "mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-blue-100";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-slate-600";

export default function PickupCourierAddressBook() {
  const [branches, setBranches] = useState<PickupCourierBranch[]>([]);
  const [profiles, setProfiles] = useState<PickupCourierAddress[]>([]);
  const [branchId, setBranchId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState<PickupAddress>(emptyAddress);
  const [contact, setContact] = useState({ name: "", phone: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const result = await listPickupCourierAddresses();
      setBranches(result.branches);
      setProfiles(result.courierAddresses);
      setBranchId((current) => result.branches.some((branch) => branch.id === current) ? current : result.branches[0]?.id ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Courier addresses could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void Promise.resolve().then(load); }, []);

  function clearForm() {
    setEditingId("");
    setCompanyName("");
    setAddress({ ...emptyAddress });
    setContact({ name: "", phone: "" });
  }

  function edit(profile: PickupCourierAddress) {
    setBranchId(profile.branchId);
    setEditingId(profile.id);
    setCompanyName(profile.companyName);
    setAddress({ ...profile.address });
    setContact({ ...profile.contact, phone: profile.contact.phone.replace(/\D/g, "") });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await savePickupCourierAddress({ branchId, companyName, address, contact }, editingId || undefined);
      toast.success(editingId ? "Courier address updated." : "Courier address saved.");
      clearForm();
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Courier address could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const visible = profiles.filter((profile) => profile.branchId === branchId);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(280px,.8fr)_minmax(0,1.2fr)]">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">Saved courier locations</h2>
          <p className="mt-1 text-sm text-slate-500">Choose a branch to manage its pickup defaults.</p>
        </div>
        <label className={labelClass + " mt-5"}>Branch
          <select value={branchId} onChange={(event) => { setBranchId(event.target.value); clearForm(); }} className={fieldClass}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}
          </select>
        </label>
        {error ? <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        {loading ? <p className="mt-5 text-sm text-slate-500">Loading courier addresses…</p> : null}
        {!loading && !branches.length ? <p className="mt-5 text-sm text-slate-500">No active branch is available to your login.</p> : null}
        <div className="mt-5 space-y-2">
          {visible.map((profile) => (
            <button key={profile.id} type="button" onClick={() => edit(profile)} className={`w-full rounded-xl border p-4 text-left transition hover:border-blue-400 focus-visible:outline-2 focus-visible:outline-blue-600 ${editingId === profile.id ? "border-blue-600 bg-blue-50" : "border-slate-200"}`}>
              <span className="flex items-center gap-2 font-semibold text-slate-950"><FiTruck className="shrink-0 text-[#0D1282]" />{profile.companyName}</span>
              <span className="mt-2 block text-sm text-slate-600">{profile.address.addressLine1}, {profile.address.townOrCity}, {profile.address.postcode}</span>
              <span className="mt-1 block text-xs text-slate-500">{profile.contact.name} · {profile.contact.phone}</span>
            </button>
          ))}
          {!loading && !!branches.length && !visible.length ? <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">No courier address saved for this branch yet.</p> : null}
        </div>
      </section>

      <form onSubmit={(event) => void save(event)} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{editingId ? "Edit courier details" : "Add a courier location"}</h2>
            <p className="mt-1 text-sm text-slate-500">Clients can review and edit these details when requesting pickup.</p>
          </div>
          {editingId ? <button type="button" onClick={clearForm} className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"><FiPlus /> New</button> : null}
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className={labelClass + " sm:col-span-2"}>Transport / courier company <span className="text-red-600">*</span>
            <input required list="pickup-courier-company-options" maxLength={120} value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Choose or enter a courier" className={fieldClass} />
            <datalist id="pickup-courier-company-options">{pickupTransportCompanies.map((company) => <option key={company} value={company} />)}</datalist>
          </label>
          <div className="sm:col-span-2 border-t border-slate-200 pt-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950"><FiMapPin /> Collection address</h3>
          </div>
          <label className={labelClass + " sm:col-span-2"}>Address line 1 <span className="text-red-600">*</span><input required minLength={3} maxLength={180} value={address.addressLine1} onChange={(event) => setAddress({ ...address, addressLine1: event.target.value })} className={fieldClass} /></label>
          <label className={labelClass + " sm:col-span-2"}>Building, floor or landmark <span className="font-normal normal-case text-slate-400">(optional)</span><input maxLength={180} value={address.addressLine2 ?? ""} onChange={(event) => setAddress({ ...address, addressLine2: event.target.value })} className={fieldClass} /></label>
          <label className={labelClass}>City <span className="text-red-600">*</span><input required minLength={2} maxLength={100} value={address.townOrCity} onChange={(event) => setAddress({ ...address, townOrCity: event.target.value })} className={fieldClass} /></label>
          <label className={labelClass}>State <input maxLength={100} value={address.county ?? ""} onChange={(event) => setAddress({ ...address, county: event.target.value })} className={fieldClass} /></label>
          <label className={labelClass + " sm:col-span-2"}>PIN / postal code <span className="text-red-600">*</span><input required minLength={3} maxLength={20} value={address.postcode} onChange={(event) => setAddress({ ...address, postcode: event.target.value })} className={fieldClass} /></label>
          <div className="sm:col-span-2 border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-950">Courier collection contact</h3></div>
          <label className={labelClass}>Contact name <span className="text-red-600">*</span><input required maxLength={120} value={contact.name} onChange={(event) => setContact({ ...contact, name: event.target.value })} className={fieldClass} /></label>
          <label className={labelClass}>Phone number <span className="text-red-600">*</span><input required type="tel" inputMode="numeric" pattern="[0-9]{6,30}" title="Enter 6 to 30 digits only" minLength={6} maxLength={30} value={contact.phone} onChange={(event) => setContact({ ...contact, phone: event.target.value.replace(/\D/g, "") })} className={fieldClass} /></label>
        </div>
        <div className="mt-6 flex justify-end border-t border-slate-200 pt-5">
          <button type="submit" disabled={saving || !branchId} className="rounded-xl bg-[#0D1282] px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Saving…" : editingId ? "Save changes" : "Save courier address"}</button>
        </div>
      </form>
    </div>
  );
}
