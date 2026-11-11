"use client";

import { useEffect, useState } from "react";
import { FiChevronDown, FiEye, FiPlus, FiSave } from "react-icons/fi";
import { toast } from "react-toastify";
import WhatsNewModal from "@/components/whats-new/WhatsNewModal";
import FeatureAnnouncementEditor from "@/components/operations-advisory/FeatureAnnouncementEditor";
import { listAnnouncementTargets, listManagedAnnouncements, saveAnnouncement, type AnnouncementRole, type AnnouncementStatus, type FeatureAnnouncement, type FeatureAnnouncementDraftBlock, type FeatureAnnouncementInput } from "@/lib/featureAnnouncements";

const staffRoles: AnnouncementRole[] = ["admin", "operations", "finance", "delivery", "hr"];
const istOffset = 330 * 60_000;
const toIstInput = (iso: string | null) => iso ? new Date(new Date(iso).getTime() + istOffset).toISOString().slice(0, 16) : "";
const fromIstInput = (value: string) => value ? new Date(`${value}:00+05:30`).toISOString() : null;
const defaultForm = (): FeatureAnnouncementInput => ({
  title: "", summary: "", body: "", contentBlocks: [{ type: "text", text: "" }], targetHref: "/client/dashboard", clientTargetHref: null, roles: ["client"], videoUrl: null,
  status: "DRAFT", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 14 * 86400_000).toISOString()
});
const fromItem = (item: FeatureAnnouncement): FeatureAnnouncementInput => ({
  title: item.title, summary: item.summary, body: item.body, contentBlocks: item.contentBlocks.map((block) => ({ ...block })), targetHref: item.targetHref, clientTargetHref: item.clientTargetHref,
  roles: item.roles, videoUrl: item.videoUrl, status: item.status, startsAt: item.startsAt, endsAt: item.endsAt
});
const statusLabel = (item: FeatureAnnouncement) => {
  if (item.status !== "PUBLISHED") return item.status.toLowerCase();
  if (item.startsAt && Date.parse(item.startsAt) > Date.now()) return "scheduled";
  if (item.endsAt && Date.parse(item.endsAt) <= Date.now()) return "expired";
  return "live";
};
const fieldClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15";

export default function FeatureAnnouncementManager() {
  const [items, setItems] = useState<FeatureAnnouncement[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [targets, setTargets] = useState<Array<{ href: string; roles: AnnouncementRole[] }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FeatureAnnouncementInput>(defaultForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailableSelection, setUnavailableSelection] = useState(false);
  const [preview, setPreview] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const current = items.find((item) => item.id === selected);
  const hasClient = form.roles.includes("client");
  const staffAudience = form.roles.some((role) => role !== "client");
  const audienceMode = hasClient && staffAudience ? "both" : hasClient ? "client" : "staff";

  useEffect(() => {
    let active = true;
    void Promise.all([listManagedAnnouncements(), listAnnouncementTargets()]).then(([page, destinations]) => {
      if (active) { setItems(page.announcements); setNextCursor(page.nextCursor); setTargets(destinations); setLoading(false); }
    }).catch((cause: unknown) => {
      if (active) { toast.error(cause instanceof Error ? cause.message : "Announcements could not be loaded."); setLoading(false); }
    });
    return () => { active = false; };
  }, []);

  function choose(item: FeatureAnnouncement | null) {
    setSelected(item?.id ?? null);
    setForm(item ? fromItem(item) : defaultForm());
    setEditorVersion((version) => version + 1);
    setUnavailableSelection(false);
  }
  function update<K extends keyof FeatureAnnouncementInput>(key: K, value: FeatureAnnouncementInput[K]) {
    setForm((currentForm) => ({ ...currentForm, [key]: value }));
  }
  function updateContentBlocks(contentBlocks: FeatureAnnouncementDraftBlock[]) {
    const body = contentBlocks.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    setForm((currentForm) => ({ ...currentForm, contentBlocks, body }));
  }
  function changeAudience(mode: "client" | "staff" | "both") {
    setForm((currentForm) => ({ ...currentForm, roles: mode === "client" ? ["client"] : mode === "both" ? ["operations", "client"] : ["operations"], targetHref: mode === "client" ? "/client/dashboard" : "/dashboard", clientTargetHref: mode === "both" ? "/client/dashboard" : null }));
  }
  function changeStaffRole(role: AnnouncementRole, checked: boolean) {
    const roles = checked ? [...form.roles, role] : form.roles.filter((value) => value !== role);
    if (!roles.some((value) => value !== "client")) return;
    const destination = targets.find((target) => target.href === form.targetHref);
    setForm((currentForm) => ({ ...currentForm, roles, targetHref: destination && roles.filter((value) => value !== "client").every((value) => destination.roles.includes(value)) ? currentForm.targetHref : "/dashboard" }));
  }
  async function loadOlder() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listManagedAnnouncements(nextCursor);
      setItems((old) => [...old, ...page.announcements.filter((item) => !old.some((existing) => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Older announcements could not be loaded."); }
    finally { setLoadingMore(false); }
  }
  async function persist(input: FeatureAnnouncementInput, id = selected) {
    if (input.body.trim().length < 10) { toast.error("Details must include at least 10 characters of guide text."); return; }
    if (input.body.length > 2000) { toast.error("Details must be 2,000 characters or fewer."); return; }
    if (id && !items.some((item) => item.id === id)) {
      setUnavailableSelection(true);
      toast.error("The selected announcement is not in the current list. Choose it from the announcement list before saving.");
      return;
    }
    if (input.status === "ARCHIVED" && !window.confirm("Archive this announcement? It cannot be edited again.")) return;
    setSaving(true);
    try {
      const saved = await saveAnnouncement(input, id ?? undefined);
      setItems((old) => [saved, ...old.filter((item) => item.id !== saved.id)]);
      setSelected(saved.id); setForm(fromItem(saved));
      setEditorVersion((version) => version + 1);
      toast.success(saved.status === "PUBLISHED" ? "Announcement is scheduled or live according to its publication window." : "Announcement saved.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save announcement.";
      if (/announcement not found/i.test(message)) {
        setUnavailableSelection(Boolean(id));
        try {
          const page = await listManagedAnnouncements();
          setItems(page.announcements);
          setNextCursor(page.nextCursor);
        } catch {
          toast.error("The selected record is not available in this workspace, and the announcement list could not be refreshed.");
        }
        toast.error("This announcement could not be found in the current workspace. Your guide remains in the form; choose an available record or start a new announcement before saving again.");
      } else toast.error(message);
    }
    finally { setSaving(false); }
  }
  const previewItem: FeatureAnnouncement = {
    id: current?.id ?? "preview", ...form,
    contentBlocks: form.contentBlocks.map((block, blockIndex) => block.type === "image" ? {
      type: "image" as const, imageId: block.imageId ?? `preview-${blockIndex}`, alt: block.alt, previewUrl: block.previewUrl
    } : block),
    videoUrl: form.videoUrl ?? null, seen: false, revision: current?.revision ?? 1,
    createdAt: current?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  return (
    <section aria-label="What's new announcements" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">What&apos;s New</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Introduce portal changes with a short guide, an optional video, and a temporary New badge on the related menu item. Each person sees an update until they open it.
          </p>
        </div>
        <button type="button" onClick={() => choose(null)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">
          <FiPlus aria-hidden="true" /> New announcement
        </button>
      </div>
      {loading ? <p className="text-sm text-slate-500">Loading announcements…</p> : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.5fr)]">
        <div className="self-start overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
            Announcements <span className="text-slate-500">({items.length} loaded)</span>
          </div>
          {items.length ? (
            <div className="max-h-[650px] divide-y divide-slate-100 overflow-y-auto">
              {items.map((item) => (
                <button key={item.id} type="button" onClick={() => choose(item)} aria-current={selected === item.id ? "true" : undefined}
                  className={`w-full px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282] ${selected === item.id ? "bg-indigo-50" : ""}`}>
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{item.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${statusLabel(item) === "live" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                      {statusLabel(item)}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-500">{item.roles.join(", ")} · {item.targetHref}</span>
                </button>
              ))}
            </div>
          ) : <p className="px-4 py-6 text-sm text-slate-500">No announcements yet. Create a draft to prepare your first update.</p>}
          {nextCursor ? <button type="button" onClick={() => { void loadOlder(); }} disabled={loadingMore}
            className="w-full border-t border-slate-200 px-4 py-3 text-center text-sm font-semibold text-[#0D1282] hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">
            {loadingMore ? "Loading…" : "Load older"}
          </button> : null}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void persist(form); }} className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold text-slate-950">{selected ? "Edit announcement" : "Create announcement"}</h3>
            <span className="text-xs font-medium text-slate-500">Times shown in IST</span>
          </div>
          {current?.status === "ARCHIVED" ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">Archived announcements are read-only.</p> : null}
          {unavailableSelection ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">This announcement is no longer available in the current workspace. Your guide is still in the form. Choose another listed announcement or start a new one before saving again.</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Audience
              <span className="relative mt-1 block">
                <select value={audienceMode} onChange={(event) => changeAudience(event.target.value as "client" | "staff" | "both")}
                  disabled={current?.status === "ARCHIVED"} className={`${fieldClass} appearance-none pr-10`}>
                  <option value="client">Clients</option>
                  <option value="staff">Staff</option>
                  <option value="both">Staff and clients</option>
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </span>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              {audienceMode === "both" ? "Staff menu destination" : "Menu destination"}
              <span className="relative mt-1 block">
                <select value={form.targetHref} onChange={(event) => update("targetHref", event.target.value)}
                  disabled={current?.status === "ARCHIVED"} className={`${fieldClass} appearance-none pr-10`}>
                  {targets.filter((target) => form.roles
                    .filter((role) => audienceMode === "both" ? role !== "client" : true)
                    .every((role) => target.roles.includes(role)))
                    .map((target) => <option key={target.href} value={target.href}>{target.href}</option>)}
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </span>
            </label>
          </div>
          {audienceMode === "both" ? (
            <label className="block text-sm font-medium text-slate-700">
              Client menu destination
              <span className="relative mt-1 block">
                <select value={form.clientTargetHref ?? "/client/dashboard"} onChange={(event) => update("clientTargetHref", event.target.value)}
                  disabled={current?.status === "ARCHIVED"} className={`${fieldClass} appearance-none pr-10`}>
                  {targets.filter((target) => target.roles.includes("client"))
                    .map((target) => <option key={target.href} value={target.href}>{target.href}</option>)}
                </select>
                <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </span>
            </label>
          ) : null}
          {staffAudience ? (
            <fieldset>
              <legend className="text-sm font-medium text-slate-700">Staff roles</legend>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {staffRoles.map((role) => (
                  <label key={role} className="inline-flex items-center gap-2 text-sm capitalize text-slate-700">
                    <input type="checkbox" checked={form.roles.includes(role)} disabled={current?.status === "ARCHIVED"}
                      onChange={(event) => changeStaffRole(role, event.target.checked)} className="accent-[#0D1282]" />
                    {role}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <label className="block text-sm font-medium text-slate-700">
            Title
            <input required minLength={3} maxLength={100} value={form.title} onChange={(event) => update("title", event.target.value)}
              disabled={current?.status === "ARCHIVED"} placeholder="A faster way to book shipments" className={`mt-1 ${fieldClass}`} />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Short summary
            <input required minLength={10} maxLength={180} value={form.summary} onChange={(event) => update("summary", event.target.value)}
              disabled={current?.status === "ARCHIVED"} placeholder="A quick overview of what changed and why it helps." className={`mt-1 ${fieldClass}`} />
          </label>
          <fieldset disabled={current?.status === "ARCHIVED"} className="space-y-3">
            <legend className="text-sm font-medium text-slate-700">Details</legend>
            <p className="text-xs leading-5 text-slate-500">Write the full guide in one field. Place up to four images at the cursor; include essential instructions even when you add a video.</p>
            <FeatureAnnouncementEditor
              key={`${selected ?? "new"}:${editorVersion}`}
              announcementId={current?.id}
              value={form.contentBlocks}
              disabled={current?.status === "ARCHIVED"}
              onChange={updateContentBlocks}
              onError={(message) => toast.error(message)}
            />
            <p className="text-right text-xs text-slate-500">{form.body.length.toLocaleString()} / 2,000 characters</p>
          </fieldset>
          <label className="block text-sm font-medium text-slate-700">
            Tutorial video URL <span className="font-normal text-slate-500">(optional)</span>
            <input type="url" value={form.videoUrl ?? ""} onChange={(event) => {
              const value = event.target.value.trim();
              const markdownLink = value.match(/^\[[^\]]+\]\((https:\/\/[^)]+)\)$/);
              update("videoUrl", (markdownLink?.[1] ?? value) || null);
            }}
              disabled={current?.status === "ARCHIVED"} placeholder="https://www.youtube.com/watch?v=…" className={`mt-1 ${fieldClass}`} />
            <span className="mt-1 block text-xs text-slate-500">YouTube or Vimeo. Video loads only when the viewer presses Play.</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Publish from · IST
              <input type="datetime-local" value={toIstInput(form.startsAt)} onChange={(event) => update("startsAt", fromIstInput(event.target.value))}
                disabled={current?.status === "ARCHIVED"} className={`mt-1 ${fieldClass}`} />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Stop showing · IST
              <input type="datetime-local" value={toIstInput(form.endsAt)} onChange={(event) => update("endsAt", fromIstInput(event.target.value))}
                disabled={current?.status === "ARCHIVED"} className={`mt-1 ${fieldClass}`} />
            </label>
          </div>
          <p className="text-xs leading-5 text-slate-500">The default window is 14 days. Badges disappear when the window ends or after each person views the update. Editing published content or audience starts a new revision.</p>
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <button type="submit" disabled={saving || current?.status === "ARCHIVED" || unavailableSelection}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#252B83] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
              <FiSave aria-hidden="true" />
              {saving ? "Saving…" : form.status === "PUBLISHED" ? "Save and publish" : form.status === "ARCHIVED" ? "Archive announcement" : "Save announcement"}
            </button>
            <button type="button" onClick={() => setPreview(true)}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">
              <FiEye aria-hidden="true" /> Preview
            </button>
            {current?.status !== "ARCHIVED" ? (
              <select aria-label="Publication status" value={form.status} onChange={(event) => update("status", event.target.value as AnnouncementStatus)}
                className="ml-auto rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-[#0D1282]">
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED">Publish / schedule</option>
                {current?.status === "PUBLISHED" || current?.status === "PAUSED" ? <option value="PAUSED">Paused</option> : null}
                {current ? <option value="ARCHIVED">Archive</option> : null}
              </select>
            ) : null}
          </div>
        </form>
      </div>
      {preview ? <WhatsNewModal items={[previewItem]} onSeen={async () => {}} onClose={() => setPreview(false)} preview /> : null}
    </section>
  );
}
