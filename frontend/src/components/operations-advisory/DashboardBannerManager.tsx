"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FiCheck,
  FiEdit3,
  FiImage,
  FiPlus,
  FiSave,
  FiTrash2,
  FiUploadCloud,
  FiX,
} from "react-icons/fi";
import {
  createDashboardBanner,
  deleteDashboardBanner,
  getDashboardBannerImage,
  getDashboardBanners,
  updateDashboardBanner,
  type DashboardBanner,
  type DashboardBannerInput,
} from "@/lib/dashboardBanner";

type BannerWithImage = DashboardBanner & {
  imageSrc: string;
};

type FormState = {
  heading: string;
  description: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  file: File | null;
};

const blankForm: FormState = {
  heading: "",
  description: "",
  startsAt: "",
  endsAt: "",
  active: true,
  file: null,
};

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function scheduleLabel(slide: DashboardBanner) {
  if (slide.startsAt && slide.endsAt) {
    return `${new Date(slide.startsAt).toLocaleDateString(
      "en-IN",
    )} – ${new Date(slide.endsAt).toLocaleDateString("en-IN")}`;
  }

  if (slide.startsAt) {
    return `From ${new Date(slide.startsAt).toLocaleDateString("en-IN")}`;
  }

  if (slide.endsAt) {
    return `Until ${new Date(slide.endsAt).toLocaleDateString("en-IN")}`;
  }

  return "No date limits";
}

function statusClass(slide: DashboardBanner) {
  if (!slide.active) return "bg-slate-100 text-slate-600";
  if (slide.visible) return "bg-emerald-50 text-emerald-700";

  return "bg-amber-50 text-amber-700";
}

function statusLabel(slide: DashboardBanner) {
  if (!slide.active) return "Inactive";
  if (slide.visible) return "Live now";

  return "Scheduled";
}

export default function DashboardBannerManager() {
  const [slides, setSlides] = useState<BannerWithImage[]>([]);
  const [form, setForm] = useState<FormState>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [filePreview, setFilePreview] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageUrlsRef = useRef<string[]>([]);

  async function loadSlides() {
    setLoading(true);
    setError("");

    try {
      const result = await getDashboardBanners();

      const loaded = await Promise.all(
        result.banners.map(async (slide) => ({
          ...slide,
          imageSrc: URL.createObjectURL(
            await getDashboardBannerImage(slide.id),
          ),
        })),
      );

      imageUrlsRef.current.forEach((url) =>
        URL.revokeObjectURL(url),
      );

      imageUrlsRef.current = loaded.map(
        (slide) => slide.imageSrc,
      );

      setSlides(loaded);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Banner slides could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSlides(), 0);

    return () => {
      window.clearTimeout(timer);

      imageUrlsRef.current.forEach((url) =>
        URL.revokeObjectURL(url),
      );
    };
  }, []);

  function updateField<K extends keyof FormState>(
    field: K,
    value: FormState[K],
  ) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));

    setError("");
    setMessage("");
  }

  function chooseFile(file: File | null) {
    if (filePreview) {
      URL.revokeObjectURL(filePreview);
    }

    setForm((current) => ({
      ...current,
      file,
    }));

    setFilePreview(
      file ? URL.createObjectURL(file) : "",
    );

    setError("");
  }

  function beginCreate() {
    if (filePreview) {
      URL.revokeObjectURL(filePreview);
    }

    setEditingId(null);
    setEditorOpen(true);
    setForm(blankForm);
    setFilePreview("");
    setError("");
    setMessage("");
  }

  function beginEdit(slide: BannerWithImage) {
    if (filePreview) {
      URL.revokeObjectURL(filePreview);
    }

    setEditingId(slide.id);
    setEditorOpen(true);

    setForm({
      heading: slide.heading,
      description: slide.description,
      startsAt: dateOnly(slide.startsAt),
      endsAt: dateOnly(slide.endsAt),
      active: slide.active,
      file: null,
    });

    setFilePreview("");
    setError("");
    setMessage("");
  }

  function closeEditor() {
    if (filePreview) {
      URL.revokeObjectURL(filePreview);
    }

    setEditingId(null);
    setEditorOpen(false);
    setForm(blankForm);
    setFilePreview("");
    setError("");
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!editingId && !form.file) {
      setError(
        "Choose an image for this slide before saving.",
      );

      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    const input: DashboardBannerInput = {
      file: form.file,
      heading: form.heading.trim(),
      description: form.description.trim(),
      startsAt: form.startsAt,
      endsAt: form.endsAt,
      active: form.active,
    };

    try {
      if (editingId) {
        await updateDashboardBanner(editingId, input);
      } else {
        await createDashboardBanner(input);
      }

      closeEditor();

      await loadSlides();

      setMessage(
        editingId
          ? "Banner slide updated."
          : "Banner slide added.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Banner slide could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(
    slide: BannerWithImage,
  ) {
    if (
      !window.confirm(
        `Delete slide ${slide.order + 1}? This cannot be undone.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      await deleteDashboardBanner(slide.id);

      if (editingId === slide.id) {
        closeEditor();
      }

      await loadSlides();

      setMessage("Banner slide deleted.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Banner slide could not be deleted.",
      );
    } finally {
      setBusy(false);
    }
  }

  const editingSlide = editingId
    ? slides.find((slide) => slide.id === editingId)
    : null;

  const inputClass =
    "mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";

  const labelClass =
    "text-xs font-semibold text-slate-600";

  const previewSrc =
    filePreview || editingSlide?.imageSrc || "";

  const slideGridClass = editorOpen
    ? "grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"
    : "grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

  return (
    <div className="space-y-5">
      {/* Page heading */}
      <div data-portal-theme-advisory-heading className="flex flex-col gap-4 rounded-xl border border-[#0D1282]/10 bg-[linear-gradient(135deg,#ffffff_0%,#f7f8fd_100%)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-950">
            Dashboard banner slides
          </p>

          <p className="mt-1 text-sm leading-5 text-slate-500">
            Manage the banners shown across staff and client dashboards.
          </p>
        </div>

        <button
          type="button"
          onClick={beginCreate}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 self-start rounded-xl bg-[#F0DE36] px-4 text-sm font-bold text-[#0D1282] transition hover:bg-[#e0cf2e] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 sm:self-auto"
        >
          <FiPlus
            aria-hidden="true"
            className="h-4 w-4"
          />
          Add slide
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
          {message}
        </div>
      ) : null}

      <div
        className={`grid gap-4 ${
          editorOpen
            ? "xl:grid-cols-[minmax(0,1fr)_390px]"
            : ""
        }`}
      >
        {/* Banner list */}
        <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-950">
                Your slides
              </h2>

              <p className="mt-0.5 text-xs text-slate-500">
                Live slides rotate automatically on the dashboard.
              </p>
            </div>

            <span className="shrink-0 rounded-full bg-[#0D1282]/[0.06] px-2.5 py-1 text-xs font-semibold text-[#0D1282]">
              {slides.length}{" "}
              {slides.length === 1
                ? "slide"
                : "slides"}
            </span>
          </div>

          {loading ? (
            <div className={slideGridClass}>
              {Array.from({
                length: editorOpen ? 3 : 4,
              }).map((_, index) => (
                <div
                  key={index}
                  className="overflow-hidden rounded-xl border border-slate-100"
                >
                  <div className="aspect-[8/3] animate-pulse bg-slate-100" />

                  <div className="space-y-2 p-3">
                    <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : slides.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#0D1282]/[0.07] text-[#0D1282]">
                <FiImage
                  aria-hidden="true"
                  className="h-5 w-5"
                />
              </div>

              <h3 className="mt-4 text-sm font-semibold text-slate-950">
                No banner slides yet
              </h3>

              <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">
                Upload a banner image, then optionally add supporting copy or a display window.
              </p>

              <button
                type="button"
                onClick={beginCreate}
                className="mt-5 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-semibold text-[#0D1282] transition hover:border-[#0D1282]/30 hover:bg-[#0D1282]/[0.03]"
              >
                <FiPlus
                  aria-hidden="true"
                  className="h-4 w-4"
                />
                Create your first slide
              </button>
            </div>
          ) : (
            <div className={slideGridClass}>
              {slides.map((slide) => (
                <article
                  key={slide.id}
                  className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white transition-colors hover:border-[#0D1282]/20"
                >
                  {/* Smaller banner thumbnail */}
                  <div className="relative aspect-[8/3] overflow-hidden bg-slate-100">
                    <img
                      src={slide.imageSrc}
                      alt={
                        slide.heading ||
                        `Banner slide ${slide.order + 1}`
                      }
                      className="h-full w-full object-cover"
                    />

                    <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/25 to-transparent" />

                    <span
                      className={`absolute left-2.5 top-2.5 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${statusClass(
                        slide,
                      )}`}
                    >
                      {statusLabel(slide)}
                    </span>

                    <span className="absolute right-2.5 top-2.5 rounded-md bg-black/35 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      #{slide.order + 1}
                    </span>
                  </div>

                  <div className="p-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-slate-950">
                        {slide.heading ||
                          "Image-only slide"}
                      </p>

                      <p className="mt-1 truncate text-[11px] font-medium text-slate-500">
                        {scheduleLabel(slide)}
                      </p>
                    </div>

                    {slide.description ? (
                      <p className="mt-2 line-clamp-2 text-[11px] leading-[17px] text-slate-600">
                        {slide.description}
                      </p>
                    ) : null}

                    <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          beginEdit(slide)
                        }
                        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:border-[#0D1282]/30 hover:text-[#0D1282]"
                      >
                        <FiEdit3
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                        Edit
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          void handleDelete(slide)
                        }
                        disabled={busy}
                        aria-label={`Delete slide ${
                          slide.order + 1
                        }`}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <FiTrash2
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Editor */}
        {editorOpen ? (
          <form
            onSubmit={handleSubmit}
            className="h-fit overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">
                  {editingId
                    ? "Edit slide"
                    : "Add a slide"}
                </h2>

                <p className="mt-1 text-xs text-slate-500">
                  Image required. Copy and dates are optional.
                </p>
              </div>

              {editingId ? (
                <button
                  type="button"
                  onClick={closeEditor}
                  aria-label="Close slide editor"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-200/60 hover:text-slate-700"
                >
                  <FiX
                    aria-hidden="true"
                    className="h-4 w-4"
                  />
                </button>
              ) : null}
            </div>

            <div className="space-y-4 p-4">
              {/* Upload */}
              <div>
                <button
                  type="button"
                  onClick={() =>
                    fileInputRef.current?.click()
                  }
                  className="group relative flex aspect-[8/3] w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50 text-center transition hover:border-[#0D1282]/40 hover:bg-[#0D1282]/[0.02]"
                >
                  {previewSrc ? (
                    <>
                      <img
                        src={previewSrc}
                        alt="Banner preview"
                        className="absolute inset-0 h-full w-full object-cover"
                      />

                      <div className="absolute inset-0 bg-black/10 transition group-hover:bg-black/20" />
                    </>
                  ) : null}

                  <span
                    className={`relative flex flex-col items-center gap-1.5 rounded-lg px-4 py-3 text-xs font-semibold ${
                      previewSrc
                        ? "bg-slate-950/70 text-white"
                        : "text-slate-600"
                    }`}
                  >
                    <FiUploadCloud
                      aria-hidden="true"
                      className="h-5 w-5"
                    />

                    <span>
                      {form.file
                        ? form.file.name
                        : editingId
                          ? "Replace image"
                          : "Choose banner image"}
                    </span>

                    <span
                      className={`text-[10px] font-medium ${
                        previewSrc
                          ? "text-white/70"
                          : "text-slate-400"
                      }`}
                    >
                      Recommended 1600 × 600 px
                    </span>
                  </span>
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(
                    event: ChangeEvent<HTMLInputElement>,
                  ) =>
                    chooseFile(
                      event.target.files?.[0] ??
                        null,
                    )
                  }
                  className="sr-only"
                />

                {/* Desktop image guidance */}
                <div className="mt-2 flex items-start gap-2 rounded-lg bg-[#0D1282]/[0.035] px-3 py-2">
                  <FiImage
                    aria-hidden="true"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0D1282]"
                  />

                  <p className="text-[11px] leading-4 text-slate-600">
                    <strong className="font-semibold text-slate-700">
                      Desktop banner:
                    </strong>{" "}
                    1600 × 600 px (8:3). JPG, PNG or WebP.
                  </p>
                </div>
              </div>

              <label className="block">
                <span className={labelClass}>
                  Heading{" "}
                  <span className="font-normal text-slate-400">
                    (optional)
                  </span>
                </span>

                <input
                  value={form.heading}
                  onChange={(event) =>
                    updateField(
                      "heading",
                      event.target.value,
                    )
                  }
                  maxLength={120}
                  className={inputClass}
                  placeholder="e.g. Plan around the holiday cut-off"
                />
              </label>

              <label className="block">
                <span className={labelClass}>
                  Description{" "}
                  <span className="font-normal text-slate-400">
                    (optional)
                  </span>
                </span>

                <textarea
                  value={form.description}
                  onChange={(event) =>
                    updateField(
                      "description",
                      event.target.value,
                    )
                  }
                  maxLength={500}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
                  placeholder="Add a short message for dashboard viewers"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={labelClass}>
                    From{" "}
                    <span className="font-normal text-slate-400">
                      (optional)
                    </span>
                  </span>

                  <input
                    type="date"
                    value={form.startsAt}
                    onChange={(event) =>
                      updateField(
                        "startsAt",
                        event.target.value,
                      )
                    }
                    className={inputClass}
                  />
                </label>

                <label className="block">
                  <span className={labelClass}>
                    To{" "}
                    <span className="font-normal text-slate-400">
                      (optional)
                    </span>
                  </span>

                  <input
                    type="date"
                    value={form.endsAt}
                    onChange={(event) =>
                      updateField(
                        "endsAt",
                        event.target.value,
                      )
                    }
                    className={inputClass}
                  />
                </label>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(event) =>
                    updateField(
                      "active",
                      event.target.checked,
                    )
                  }
                  className="h-4 w-4 accent-[#0D1282]"
                />

                <span>Publish this slide</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-4 py-3">
              {editingId ? (
                <button
                  type="button"
                  onClick={closeEditor}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  Cancel
                </button>
              ) : null}

              <button
                type="submit"
                disabled={busy}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white transition hover:bg-[#090d69] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FiSave
                  aria-hidden="true"
                  className="h-4 w-4"
                />

                {busy
                  ? "Saving..."
                  : editingId
                    ? "Save changes"
                    : "Add slide"}
              </button>
            </div>
          </form>
        ) : null}
      </div>

      {/* Management information */}
      <div className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        <FiCheck
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
        />

        Only active slides inside their optional date window are shown on dashboards. Inactive or scheduled slides stay visible here for management.
      </div>
    </div>
  );
}
