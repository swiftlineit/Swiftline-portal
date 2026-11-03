"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FiCheck, FiChevronLeft, FiChevronRight, FiImage, FiTrash2, FiUpload, FiX } from "react-icons/fi";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import { getOperatorSession, updateOperatorSlug, type OperatorSession } from "@/lib/operatorDirectory";
import {
  getOperatorSettings,
  loadOperatorBannerImage,
  loadOperatorCompanyLogo,
  OperatorSettingsError,
  removeOperatorBanner,
  updateOperatorBranch,
  updateOperatorCompanyLogo,
  updateOperatorCompanyName,
  uploadOperatorBanner,
  type OperatorSettingsBanner,
  type OperatorSettingsBranch,
  type OperatorSettingsPayload
} from "@/lib/operatorSettings";

const inputClass = "min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20";
const labelClass = "mb-1.5 block text-sm font-medium text-slate-700";
const titleCase = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

function BranchSettingsCard({
  branch,
  operatorSlug,
  canEdit,
  onSaved
}: {
  branch: OperatorSettingsBranch;
  operatorSlug: string;
  canEdit: boolean;
  onSaved: (branch: OperatorSettingsBranch) => void;
}) {
  const [draft, setDraft] = useState(branch);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setAddress(key: keyof OperatorSettingsBranch["address"], value: string) {
    setDraft((current) => ({ ...current, address: { ...current.address, [key]: value } }));
  }

  function setContact(key: "email" | "phone", value: string) {
    setDraft((current) => ({ ...current, contact: { ...current.contact, [key]: value } }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !editing) return;
    setSaving(true);
    setError("");
    try {
      const result = await updateOperatorBranch(operatorSlug, branch._id, {
        name: draft.name.trim(),
        openingDate: draft.openingDate || null,
        description: (draft.description ?? "").trim(),
        address: draft.address,
        contact: draft.contact,
        gstin: (draft.gstin ?? "").trim().toUpperCase(),
        invoiceSacCode: (draft.invoiceSacCode ?? "").trim(),
        baseCurrency: (draft.baseCurrency ?? "").trim().toUpperCase()
      });
      setDraft(result.branch);
      onSaved(result.branch);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Branch details could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function close() {
    setOpen(false);
    setEditing(false);
    setError("");
    setDraft(branch);
  }

  const addressLine = [branch.address.address, branch.address.city, branch.address.stateOrProvince, branch.address.countryName].filter(Boolean).join(", ");

  return (
    <>
      <article className="flex min-w-0 items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold text-slate-950">{branch.name}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{branch.code}</span></div><p className="mt-1 truncate text-sm text-slate-500">{addressLine || "Branch address not provided"}</p></div>
        <button type="button" onClick={() => { setDraft(branch); setEditing(false); setOpen(true); }} className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-[#0D1282] hover:bg-slate-50">Details</button>
      </article>
      {open ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close(); }}>
        <form onSubmit={(event) => void save(event)} role="dialog" aria-modal="true" aria-labelledby={`branch-${branch._id}-title`} className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
          <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6"><div><h2 id={`branch-${branch._id}-title`} className="text-lg font-semibold text-slate-950">{branch.name}</h2><p className="mt-1 text-sm text-slate-500">{branch.code} · {titleCase(branch.status)}{branch.baseCurrency ? ` · ${branch.baseCurrency}` : ""}</p></div><button type="button" onClick={close} disabled={saving} aria-label="Close branch details" className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><FiX aria-hidden="true" /></button></header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 [scrollbar-width:thin] sm:p-6"><div className="grid gap-4 sm:grid-cols-2">
            <label><span className={labelClass}>Branch name</span><input className={inputClass} required minLength={3} maxLength={100} disabled={!editing || saving} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            <label><span className={labelClass}>Opening date</span><input className={inputClass} type="date" disabled={!editing || saving} value={draft.openingDate ? new Date(draft.openingDate).toISOString().slice(0, 10) : ""} onChange={(event) => setDraft((current) => ({ ...current, openingDate: event.target.value || null }))} /></label>
            <label className="sm:col-span-2"><span className={labelClass}>Description</span><textarea className={`${inputClass} min-h-20 resize-y`} maxLength={500} disabled={!editing || saving} value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
            <label className="sm:col-span-2"><span className={labelClass}>Registered address</span><input className={inputClass} maxLength={500} disabled={!editing || saving} value={draft.address.address ?? ""} onChange={(event) => setAddress("address", event.target.value)} /></label>
            <label><span className={labelClass}>City</span><input className={inputClass} maxLength={80} disabled={!editing || saving} value={draft.address.city ?? ""} onChange={(event) => setAddress("city", event.target.value)} /></label>
            <label><span className={labelClass}>State or province</span><input className={inputClass} maxLength={80} disabled={!editing || saving} value={draft.address.stateOrProvince ?? ""} onChange={(event) => setAddress("stateOrProvince", event.target.value)} /></label>
            <label><span className={labelClass}>Postal code</span><input className={inputClass} maxLength={20} disabled={!editing || saving} value={draft.address.postalCode ?? ""} onChange={(event) => setAddress("postalCode", event.target.value)} /></label>
            <label><span className={labelClass}>Country</span><input className={inputClass} maxLength={80} disabled={!editing || saving} value={draft.address.countryName ?? ""} onChange={(event) => setAddress("countryName", event.target.value)} /></label>
            <label><span className={labelClass}>Country code</span><input className={inputClass} maxLength={2} disabled={!editing || saving} value={draft.address.countryCode ?? ""} onChange={(event) => setAddress("countryCode", event.target.value.toUpperCase())} /></label>
            <label><span className={labelClass}>Contact email</span><input className={inputClass} type="email" maxLength={254} disabled={!editing || saving} value={draft.contact.email ?? ""} onChange={(event) => setContact("email", event.target.value)} /></label>
            <label><span className={labelClass}>Contact phone</span><input className={inputClass} type="tel" maxLength={30} disabled={!editing || saving} value={draft.contact.phone ?? ""} onChange={(event) => setContact("phone", event.target.value)} /></label>
            <label><span className={labelClass}>GSTIN</span><input className={inputClass} maxLength={15} disabled={!editing || saving} value={draft.gstin ?? ""} onChange={(event) => setDraft((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))} /></label>
            <label><span className={labelClass}>Invoice SAC code</span><input className={inputClass} maxLength={12} disabled={!editing || saving} value={draft.invoiceSacCode ?? ""} onChange={(event) => setDraft((current) => ({ ...current, invoiceSacCode: event.target.value }))} /></label>
            <label><span className={labelClass}>Invoice currency</span><input className={inputClass} maxLength={3} disabled={!editing || saving} value={draft.baseCurrency ?? ""} onChange={(event) => setDraft((current) => ({ ...current, baseCurrency: event.target.value.toUpperCase() }))} /></label>
          </div>{error ? <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p> : null}</div>
          <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-4 sm:px-6">
            {editing ? <button type="button" onClick={() => { setDraft(branch); setEditing(false); setError(""); }} disabled={saving} className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button> : <button type="button" onClick={close} className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Close</button>}
            {canEdit ? editing ? <button type="submit" disabled={saving} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#10166F] disabled:opacity-55"><FiCheck aria-hidden="true" />{saving ? "Saving…" : "Save"}</button> : <button type="button" onClick={(event) => { event.preventDefault(); setError(""); setEditing(true); }} className="inline-flex min-h-10 items-center rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#10166F]">Edit</button> : null}
          </footer>
        </form>
      </div> : null}
    </>
  );
}

export default function OperatorSettingsPage({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [data, setData] = useState<OperatorSettingsPayload | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [slugDraft, setSlugDraft] = useState(operatorSlug);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingSlug, setSavingSlug] = useState(false);
  const [slugError, setSlugError] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [savingLogo, setSavingLogo] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [logoNotice, setLogoNotice] = useState("");
  const [error, setError] = useState("");
  const [companyNotice, setCompanyNotice] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const bannerPreviewUrlRef = useRef<string | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string | null>(null);
  const [bannerDragActive, setBannerDragActive] = useState(false);
  const [bannerHeading, setBannerHeading] = useState("");
  const [bannerDescription, setBannerDescription] = useState("");
  const [bannerImages, setBannerImages] = useState<Record<string, string>>({});
  const [previewBannerId, setPreviewBannerId] = useState<string | null>(null);
  const [savingBanner, setSavingBanner] = useState(false);
  const [bannerError, setBannerError] = useState("");
  const [bannerNotice, setBannerNotice] = useState("");
  const operatorId = data?.operator.id ?? null;
  const logoUpdatedAt = data?.operator.logo?.updatedAt ?? null;
  const savedBanners = data?.banners ?? [];
  const previewBanner = savedBanners.find((banner) => banner.id === previewBannerId)
    ?? (savedBanners.length ? savedBanners[savedBanners.length - 1]! : null);
  const previewBannerIndex = previewBanner ? savedBanners.findIndex((banner) => banner.id === previewBanner.id) : -1;

  useEffect(() => () => {
    if (bannerPreviewUrlRef.current) URL.revokeObjectURL(bannerPreviewUrlRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.all([
      getOperatorSettings(operatorSlug, page, controller.signal),
      getOperatorSession(operatorSlug, controller.signal)
    ]).then(([result, currentSession]) => {
      if (!active || controller.signal.aborted) return;
      setData(result);
      setSession(currentSession);
      setCompanyName(result.operator.companyName);
      setSlugDraft(result.operator.slug);
      setError("");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (cause instanceof OperatorSettingsError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/settings`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Operator settings could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, page, router]);

  useEffect(() => {
    if (!data?.banners.length) return;
    let active = true;
    const controller = new AbortController();
    let urls: string[] = [];
    void Promise.allSettled(data.banners.map((banner) => loadOperatorBannerImage(operatorSlug, banner.id, controller.signal))).then((results) => {
      const loaded = results.flatMap((result, index) => result.status === "fulfilled" ? [[data.banners[index]!.id, result.value] as const] : []);
      urls = loaded.map(([, url]) => url);
      if (active) setBannerImages(Object.fromEntries(loaded));
      else urls.forEach((url) => URL.revokeObjectURL(url));
    });
    return () => { active = false; controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [data?.banners, operatorSlug]);

  useEffect(() => {
    if (!operatorId) return;
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    loadOperatorCompanyLogo(operatorSlug, controller.signal).then((url) => {
      if (!active) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setLogoPreviewUrl(url);
    }).catch((cause: unknown) => {
      if (active && !controller.signal.aborted) {
        setLogoError(cause instanceof Error ? cause.message : "Company logo could not be loaded.");
      }
    });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [operatorSlug, operatorId, logoUpdatedAt]);

  async function saveCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingCompany(true);
    setError("");
    setCompanyNotice("");
    try {
      const result = await updateOperatorCompanyName(operatorSlug, companyName.trim());
      setCompanyName(result.operator.companyName);
      setData((current) => current ? {
        ...current,
        operator: {
          ...current.operator,
          slug: result.operator.slug,
          companyName: result.operator.companyName
        }
      } : current);
      setCompanyNotice("Company name saved. New tax invoices will show this name.");
      if (result.operator.slug !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(result.operator.slug)}/settings`);
      }
    } catch (cause) {
      if (cause instanceof OperatorSettingsError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/settings`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Company name could not be saved.");
    } finally {
      setSavingCompany(false);
    }
  }

  async function savePortalUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingSlug || !data) return;
    setSavingSlug(true);
    setSlugError("");
    try {
      const result = await updateOperatorSlug(operatorSlug, slugDraft);
      router.replace(`/portal/${encodeURIComponent(result.operator.slug)}/settings`);
    } catch (cause) {
      setSlugError(cause instanceof Error ? cause.message : "Unable to update the portal URL.");
    } finally {
      setSavingSlug(false);
    }
  }

  async function saveLogo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!logoFile) return;
    setSavingLogo(true);
    setLogoError("");
    setLogoNotice("");
    try {
      const result = await updateOperatorCompanyLogo(operatorSlug, logoFile);
      setData((current) => current ? {
        ...current,
        operator: { ...current.operator, logo: result.logo }
      } : current);
      setLogoFile(null);
      if (logoInputRef.current) logoInputRef.current.value = "";
      setLogoNotice("Company logo saved. New tax and shipment invoice PDFs will use this logo.");
    } catch (cause) {
      if (cause instanceof OperatorSettingsError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/settings`);
        return;
      }
      setLogoError(cause instanceof Error ? cause.message : "Company logo could not be saved.");
    } finally {
      setSavingLogo(false);
    }
  }

  async function saveBanner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bannerFile) return;
    setSavingBanner(true);
    setBannerError("");
    setBannerNotice("");
    try {
      const result = await uploadOperatorBanner(operatorSlug, bannerFile, bannerHeading, bannerDescription);
      setPreviewBannerId(result.banner.id);
      setData((current) => current ? { ...current, banners: [...current.banners, result.banner] } : current);
      clearSelectedBannerFile();
      setBannerHeading("");
      setBannerDescription("");
      if (bannerInputRef.current) bannerInputRef.current.value = "";
      setBannerNotice("Banner added to the workspace home page.");
    } catch (cause) {
      if (cause instanceof OperatorSettingsError && cause.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(cause.canonicalSlug)}/settings`);
        return;
      }
      setBannerError(cause instanceof Error ? cause.message : "Banner could not be uploaded.");
    } finally {
      setSavingBanner(false);
    }
  }

  function clearSelectedBannerFile() {
    if (bannerPreviewUrlRef.current) URL.revokeObjectURL(bannerPreviewUrlRef.current);
    bannerPreviewUrlRef.current = null;
    setBannerPreviewUrl(null);
    setBannerFile(null);
  }

  function selectBannerFile(file: File | null): boolean {
    setBannerNotice("");
    if (!file) return false;
    const isSupportedImage = ["image/jpeg", "image/png"].includes(file.type) || /\.(jpe?g|png)$/i.test(file.name);
    if (!isSupportedImage) {
      setBannerError("Choose a JPG or PNG image.");
      return false;
    }
    if (file.size > 2 * 1024 * 1024) {
      setBannerError("Choose a banner image no larger than 2 MB.");
      return false;
    }
    if (bannerPreviewUrlRef.current) URL.revokeObjectURL(bannerPreviewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    bannerPreviewUrlRef.current = previewUrl;
    setBannerPreviewUrl(previewUrl);
    setBannerFile(file);
    setBannerError("");
    return true;
  }

  async function deleteBanner(banner: OperatorSettingsBanner) {
    setSavingBanner(true);
    setBannerError("");
    setBannerNotice("");
    try {
      await removeOperatorBanner(operatorSlug, banner.id);
      if (previewBannerId === banner.id) setPreviewBannerId(null);
      setData((current) => current ? { ...current, banners: current.banners.filter((item) => item.id !== banner.id) } : current);
      setBannerNotice("Banner removed from the workspace home page.");
    } catch (cause) {
      setBannerError(cause instanceof Error ? cause.message : "Banner could not be removed.");
    } finally {
      setSavingBanner(false);
    }
  }

  function moveBannerPreview(offset: number) {
    if (savedBanners.length < 2 || previewBannerIndex < 0) return;
    const nextIndex = (previewBannerIndex + offset + savedBanners.length) % savedBanners.length;
    setPreviewBannerId(savedBanners[nextIndex]!.id);
  }

  function updateBranch(branch: OperatorSettingsBranch) {
    setData((current) => current ? {
      ...current,
      branches: current.branches.map((item) => item._id === branch._id ? branch : item)
    } : current);
  }

  const branches = data?.branches ?? [];
  const pagination = data?.pagination;
  const isAdmin = session?.membership.role === "OPERATOR_ADMIN" && !supportReadOnly;
  const canUploadBanners = !supportReadOnly && (session?.membership.role === "OPERATOR_ADMIN" || session?.membership.role === "OPERATIONS");

  if (supportReadOnly) {
    return (
      <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
        <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-950">Company and invoice settings</h1>
              <p className="mt-2 text-sm leading-5 text-slate-600">Viewing saved operator identity and invoice details.</p>
            </div>
          </div>
          {error ? <div role="alert" className="rounded-md border border-rose-200 bg-white p-4 text-sm text-rose-800">{error}</div> : null}
          {loading ? <div role="status" className="flex min-h-56 items-center justify-center rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">Loading settings</div> : data ? (
            <>
              <section className="grid gap-5 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[minmax(0,1fr)_12rem] sm:p-5">
                <div><h2 className="text-base font-semibold text-slate-950">Operator company</h2><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Legal name</dt><dd className="mt-1 break-words text-slate-900">{data.operator.companyName}</dd></div><div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Portal URL</dt><dd className="mt-1 break-all text-slate-900">/portal/{data.operator.slug}</dd></div></dl></div>
                <div className="flex min-h-28 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 p-3">
                  {logoPreviewUrl ? <Image src={logoPreviewUrl} alt={`${data.operator.companyName} logo`} width={384} height={192} unoptimized className="max-h-24 max-w-full object-contain" /> : <div className="flex items-center gap-2 text-sm text-slate-600"><FiImage aria-hidden="true" />{data.operator.logo ? "Logo preview unavailable" : "No logo uploaded"}</div>}
                </div>
              </section>
              <section className="space-y-3" aria-labelledby="support-invoice-details">
                <div><h2 id="support-invoice-details" className="text-base font-semibold text-slate-950">Branch invoice details</h2><p className="mt-1 text-sm text-slate-600">Saved legal and contact details used for newly issued invoices.</p></div>
                {branches.length ? branches.map((branch) => <article key={branch._id} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold text-slate-950">{branch.name}</h3><p className="mt-1 text-xs text-slate-600">{branch.code}  {branch.status.replaceAll("_", " ")}</p></div>{branch.baseCurrency ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{branch.baseCurrency}</span> : null}</div><dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3"><div><dt className="text-xs font-medium text-slate-500">Registered address</dt><dd className="mt-1 text-slate-800">{[branch.address.address, branch.address.city, branch.address.stateOrProvince, branch.address.postalCode, branch.address.countryName].filter(Boolean).join(", ") || "Not provided"}</dd></div><div><dt className="text-xs font-medium text-slate-500">GSTIN</dt><dd className="mt-1 text-slate-800">{branch.gstin || "Not provided"}</dd></div><div><dt className="text-xs font-medium text-slate-500">Invoice SAC code</dt><dd className="mt-1 text-slate-800">{branch.invoiceSacCode || "Not provided"}</dd></div><div><dt className="text-xs font-medium text-slate-500">Invoice email</dt><dd className="mt-1 break-all text-slate-800">{branch.contact.email || "Not provided"}</dd></div><div><dt className="text-xs font-medium text-slate-500">Invoice phone</dt><dd className="mt-1 text-slate-800">{branch.contact.phone || "Not provided"}</dd></div></dl></article>) : <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">No invoice branches are available.</div>}
              </section>
            </>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-950">Workspace settings</h1>
            <p className="mt-1 text-sm leading-5 text-slate-600">Manage your operator profile, home banners, and branch details.</p>
          </div>
        </div>

        {error ? <div role="alert" className="rounded-md border border-rose-200 bg-white p-4 text-sm text-rose-800">{error}</div> : null}

        {isAdmin ? <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <section aria-labelledby="operator-identity-heading" className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <header className="border-b border-slate-200 px-5 py-4 sm:px-6"><h2 id="operator-identity-heading" className="text-base font-semibold text-slate-950">Company and workspace URL</h2><p className="mt-1 text-sm text-slate-600">Set the company name and address shown across this workspace.</p></header>
            <div className="flex flex-1 flex-col justify-center gap-5 p-5 sm:p-6">
              <form onSubmit={(event) => void saveCompany(event)} className="grid content-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <label className="min-w-0"><span className={labelClass}>Company name</span><input className={inputClass} required minLength={1} maxLength={160} disabled={loading || savingCompany} value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
                <button type="submit" disabled={savingCompany || loading || !companyName.trim() || !data} className="inline-flex min-h-10 min-w-28 items-center justify-center rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] disabled:cursor-wait disabled:opacity-55">{savingCompany ? "Saving..." : "Save name"}</button>
              </form>
              <form onSubmit={(event) => void savePortalUrl(event)} className="grid content-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0"><label htmlFor="operator-portal-slug" className={labelClass}>Workspace URL</label><div className="flex min-h-10 items-center rounded-md border border-slate-300 bg-white transition focus-within:border-[#0D1282] focus-within:ring-2 focus-within:ring-[#0D1282]/20"><span aria-hidden="true" className="shrink-0 pl-3 text-sm text-slate-500">/portal/</span><input id="operator-portal-slug" value={slugDraft} onChange={(event) => { setSlugDraft(event.target.value); setSlugError(""); }} maxLength={63} autoComplete="off" required disabled={loading || savingSlug} className="min-w-0 flex-1 rounded-r-md bg-transparent px-2 py-2 text-sm text-slate-900 outline-none disabled:opacity-60" /></div></div>
                <button type="submit" disabled={loading || savingSlug || !data || slugDraft.trim() === data.operator.slug} className="inline-flex min-h-10 min-w-28 items-center justify-center rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] disabled:cursor-not-allowed disabled:opacity-55">{savingSlug ? "Saving..." : "Save URL"}</button>
              </form>
              {companyNotice ? <p role="status" className="text-sm text-emerald-800">{companyNotice}</p> : null}
              {slugError ? <p role="alert" className="text-sm text-rose-700">{slugError}</p> : null}
            </div>
          </section>

          <section aria-labelledby="company-logo-heading" className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-5 py-4 sm:px-6"><h2 id="company-logo-heading" className="text-base font-semibold text-slate-950">Company logo</h2><p className="mt-1 text-sm text-slate-600">Shown on new shipment and tax invoices.</p></header>
            <div className="grid flex-1 gap-5 p-5 sm:p-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:items-center">
              <div className="flex min-h-44 items-center justify-center rounded-lg bg-slate-50 p-5">
                  {data?.operator.logo && !logoPreviewUrl && !logoError ? <div role="status" className="h-8 w-8 animate-pulse rounded bg-slate-200" aria-label="Loading company logo" /> : logoPreviewUrl ? (
                    // The protected logo is fetched with the session token and shown from a short-lived local object URL.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoPreviewUrl} alt={`${data?.operator.companyName ?? "Operator"} logo`} className="max-h-24 max-w-full object-contain" />
                  ) : <span className="text-sm text-slate-500">{logoError ? "Logo preview unavailable" : "No logo uploaded"}</span>}
              </div>
              <form onSubmit={(event) => void saveLogo(event)} className="grid min-w-0 content-center gap-3">
                <div className="min-w-0"><label className={labelClass} htmlFor="operator-company-logo">Logo file</label>
                  <input
                    ref={logoInputRef}
                    id="operator-company-logo"
                    type="file"
                    accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                    disabled={loading || savingLogo}
                    onChange={(event) => {
                      const selectedFile = event.target.files?.[0] ?? null;
                      if (selectedFile && selectedFile.size > 2 * 1024 * 1024) {
                        setLogoFile(null);
                        event.currentTarget.value = "";
                        setLogoError("Choose a logo no larger than 2 MB.");
                        setLogoNotice("");
                        return;
                      }
                      setLogoFile(selectedFile);
                      setLogoError("");
                      setLogoNotice("");
                    }}
                    className="block min-h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white text-sm text-slate-700 file:mr-3 file:min-h-10 file:cursor-pointer file:border-0 file:border-r file:border-[#0D1282] file:bg-[#0D1282] file:px-3 file:text-sm file:font-semibold file:text-white file:transition-colors hover:file:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-55 disabled:file:cursor-not-allowed disabled:file:border-slate-400 disabled:file:bg-slate-400"
                  />
                </div>
                <p className="text-xs text-slate-500">JPG or PNG, up to 2 MB.</p>
                {logoFile ? <p className="break-all text-xs text-slate-700">Selected: {logoFile.name}</p> : null}
                <button type="submit" disabled={!logoFile || savingLogo || loading} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-wait disabled:opacity-55">
                  <FiUpload aria-hidden="true" className="h-4 w-4" />{savingLogo ? "Saving" : data?.operator.logo ? "Update logo" : "Upload logo"}
                </button>
              </form>
            </div>
            {logoError ? <p role="alert" className="px-5 pb-4 text-sm text-rose-700 sm:px-6">{logoError}</p> : null}
            {logoNotice ? <p role="status" className="px-5 pb-4 text-sm text-emerald-800 sm:px-6">{logoNotice}</p> : null}
          </section>
        </div> : null}

        {canUploadBanners ? <section aria-labelledby="operator-banners-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-5 py-4 sm:px-6"><h2 id="operator-banners-heading" className="text-base font-semibold text-slate-950">Home page banners</h2><p className="mt-1 text-sm text-slate-600">Add images and optional text to the workspace home carousel.</p></header>
          <div className="grid items-stretch lg:grid-cols-2">
            <form onSubmit={(event) => void saveBanner(event)} className="flex min-w-0 flex-col gap-4 p-5 sm:p-6">
              <h3 className="text-sm font-semibold text-slate-900">Upload a banner</h3>
              <label className="block min-w-0"><span className={labelClass}>Banner image</span><input ref={bannerInputRef} type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={savingBanner || loading || (data?.banners.length ?? 0) >= 5} onChange={(event) => { const selected = event.target.files?.[0] ?? null; if (!selectBannerFile(selected)) event.currentTarget.value = ""; }} className="block min-h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white text-sm text-slate-700 file:mr-2 file:min-h-10 file:cursor-pointer file:border-0 file:border-r file:border-[#0D1282] file:bg-[#0D1282] file:px-3 file:text-sm file:font-semibold file:text-white file:transition-colors hover:file:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-55 disabled:file:cursor-not-allowed disabled:file:border-slate-400 disabled:file:bg-slate-400" /></label>
              <label className="block min-w-0"><span className={labelClass}>Heading <span className="font-normal text-slate-400">(optional)</span></span><input className={inputClass} maxLength={100} value={bannerHeading} onChange={(event) => setBannerHeading(event.target.value)} disabled={savingBanner} /></label>
              <label className="block min-w-0"><span className={labelClass}>Caption <span className="font-normal text-slate-400">(optional)</span></span><input className={inputClass} maxLength={240} value={bannerDescription} onChange={(event) => setBannerDescription(event.target.value)} disabled={savingBanner} /></label>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
                <p className="text-xs text-slate-500">JPG or PNG, up to 2 MB.</p>
                <button type="submit" disabled={!bannerFile || savingBanner || loading || (data?.banners.length ?? 0) >= 5} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-50"><FiUpload aria-hidden="true" />{savingBanner ? "Uploading..." : "Upload banner"}</button>
              </div>
              {bannerError ? <p role="alert" className="text-sm text-rose-700">{bannerError}</p> : null}
              {bannerNotice ? <p role="status" className="text-sm text-emerald-800">{bannerNotice}</p> : null}
            </form>
            <div className="min-w-0 border-t border-slate-200 p-5 sm:p-6 lg:border-l lg:border-t-0">
              <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-900">Banner preview</h3><span className="text-xs font-medium tabular-nums text-slate-500">{savedBanners.length} / 5</span></div>
              <div
                onDragOver={(event) => { event.preventDefault(); if (savedBanners.length < 5 && !savingBanner && !loading) { event.dataTransfer.dropEffect = "copy"; setBannerDragActive(true); } }}
                onDragLeave={() => setBannerDragActive(false)}
                onDrop={(event) => { event.preventDefault(); setBannerDragActive(false); if (savedBanners.length >= 5 || savingBanner || loading) return; selectBannerFile(event.dataTransfer.files?.[0] ?? null); }}
                className={`relative overflow-hidden rounded-lg border-2 border-dashed transition-colors ${bannerDragActive ? "border-[#0D1282] bg-indigo-50" : "border-slate-300 bg-slate-50"}`}
              >
                {bannerPreviewUrl ? (
                  <div className="relative aspect-[16/7]">
                    <Image src={bannerPreviewUrl} alt="Selected banner preview" fill unoptimized className="object-cover" />
                  </div>
                ) : previewBanner ? (
                  bannerImages[previewBanner.id] ? (
                    <div className="relative aspect-[16/7]">
                      <Image src={bannerImages[previewBanner.id]} alt={previewBanner.heading || "Workspace banner preview"} fill unoptimized className="object-cover" />
                    </div>
                  ) : (
                    <div role="status" className="flex aspect-[16/7] items-center justify-center gap-2 text-sm text-slate-600"><span className="size-4 animate-pulse rounded-full bg-slate-300" />Loading banner preview</div>
                  )
                ) : (
                  <button type="button" onClick={() => bannerInputRef.current?.click()} disabled={savingBanner || loading || savedBanners.length >= 5} className="flex aspect-[16/7] w-full flex-col items-center justify-center gap-2 px-4 text-center transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-60">
                    <FiUpload aria-hidden="true" className={`size-6 ${bannerDragActive ? "text-[#0D1282]" : "text-slate-500"}`} />
                    <span className="text-sm font-semibold text-slate-800">Drop an image here</span>
                    <span className="text-xs text-slate-600">or click to choose a JPG or PNG</span>
                  </button>
                )}
                {(bannerPreviewUrl || previewBanner) && savedBanners.length < 5 && !savingBanner && !loading ? (
                  <button type="button" onClick={() => bannerInputRef.current?.click()} className="absolute right-3 top-3 rounded-md bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-sm transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Change image</button>
                ) : null}
              </div>
              {bannerPreviewUrl && (bannerHeading.trim() || bannerDescription.trim()) ? <div className="mt-3 space-y-1 text-slate-900">
                {bannerHeading.trim() ? <p className="truncate text-sm font-semibold">{bannerHeading.trim()}</p> : null}
                {bannerDescription.trim() ? <p className="text-sm text-slate-600">{bannerDescription.trim()}</p> : null}
              </div> : null}
              {!bannerPreviewUrl && previewBanner && (previewBanner.heading || previewBanner.description) ? <div className="mt-3 space-y-1 text-slate-900">
                {previewBanner.heading ? <p className="truncate text-sm font-semibold">{previewBanner.heading}</p> : null}
                {previewBanner.description ? <p className="text-sm text-slate-600">{previewBanner.description}</p> : null}
              </div> : null}
              {bannerFile ? (
                <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-xs text-slate-600">Selected: {bannerFile.name}</p>
                  <button type="button" onClick={() => { clearSelectedBannerFile(); if (bannerInputRef.current) bannerInputRef.current.value = ""; }} disabled={savingBanner} className="shrink-0 text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900 disabled:opacity-50">Clear selection</button>
                </div>
              ) : previewBanner ? (
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-slate-500">Uploaded {new Date(previewBanner.uploadedAt).toLocaleDateString("en-IN")}</p>
                  <div className="flex items-center gap-2">
                    {savedBanners.length > 1 ? <div className="flex items-center gap-1">
                      <button type="button" onClick={() => moveBannerPreview(-1)} aria-label="Show previous banner" className="grid size-8 place-items-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiChevronLeft aria-hidden="true" /></button>
                      <span className="min-w-12 text-center text-xs tabular-nums text-slate-600">{previewBannerIndex + 1} / {savedBanners.length}</span>
                      <button type="button" onClick={() => moveBannerPreview(1)} aria-label="Show next banner" className="grid size-8 place-items-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiChevronRight aria-hidden="true" /></button>
                    </div> : null}
                    <button type="button" onClick={() => void deleteBanner(previewBanner)} disabled={savingBanner} aria-label={`Remove ${previewBanner.heading || "workspace banner"}`} className="grid size-8 place-items-center rounded-md border border-slate-300 bg-white text-slate-600 transition hover:border-rose-200 hover:text-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:opacity-50"><FiTrash2 aria-hidden="true" /></button>
                  </div>
                </div>
              ) : <p className="mt-3 text-xs text-slate-500">Up to five JPG or PNG images, 2 MB each.</p>}
            </div>
          </div>
        </section> : null}
        <section aria-labelledby="branch-invoice-heading" className="space-y-4">
          <div>
            <h2 id="branch-invoice-heading" className="text-base font-semibold text-slate-950">Branches</h2>
            <p className="mt-1 text-sm leading-5 text-slate-600">Review branch details and invoice information.</p>
          </div>
          {loading ? <div role="status" className="flex min-h-56 items-center justify-center rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">Loading branch settings</div> : branches.length ? (
            <div className="grid gap-3 md:grid-cols-2">{branches.map((branch) => <BranchSettingsCard key={branch._id} branch={branch} operatorSlug={operatorSlug} canEdit={isAdmin} onSaved={updateBranch} />)}</div>
          ) : <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">No operator branches have been configured yet.</div>}
          {pagination && pagination.totalPages > 1 ? (
            <nav aria-label="Branch settings pagination" className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
              <p className="text-sm text-slate-600">Page {pagination.page} of {pagination.totalPages}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }} disabled={page <= 1 || loading} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium disabled:opacity-45">Previous</button>
                <button type="button" onClick={() => { setLoading(true); setPage((value) => Math.min(pagination.totalPages, value + 1)); }} disabled={page >= pagination.totalPages || loading} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium disabled:opacity-45">Next</button>
              </div>
            </nav>
          ) : null}
        </section>
      </main>
    </div>
  );
}
