"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type Quill from "quill";
import "quill/dist/quill.snow.css";
import { FiTrash2 } from "react-icons/fi";
import { announcementImagePath, type FeatureAnnouncementDraftBlock, type FeatureAnnouncementTextRun } from "@/lib/featureAnnouncements";
import { fetchWithAuth } from "@/lib/shipmentsList";

type ImageBlock = Extract<FeatureAnnouncementDraftBlock, { type: "image" }>;
type TextBlock = Extract<FeatureAnnouncementDraftBlock, { type: "text" }>;
type QuillInstance = Quill;
type DeltaAttributes = { header?: number | false; list?: "ordered" | "bullet" | false };
type DeltaOp = { insert: string | { image: string }; attributes?: DeltaAttributes };

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const editorImageObjectUrls = new Set<string>();
let localImageBlotRegistered = false;
const unavailableImageSource = (imageId: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f1f5f9"/><path d="M430 210h100v80H430zM410 310h140" fill="none" stroke="#64748b" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><text x="480" y="370" text-anchor="middle" fill="#475569" font-family="Arial,sans-serif" font-size="24">Image ${imageId.slice(-4)} unavailable</text></svg>`
  )}`;

function createEditorImageUrl(blob: Blob) {
  const source = URL.createObjectURL(blob);
  editorImageObjectUrls.add(source);
  return source;
}

function textFromRun(run: FeatureAnnouncementTextRun) {
  return run.type === "list" ? run.items.join("\n") : run.text;
}

function textBlockFromRuns(runs: FeatureAnnouncementTextRun[]): TextBlock {
  return { type: "text", text: runs.map(textFromRun).join("\n"), runs };
}

function deltaFromRuns(runs: FeatureAnnouncementTextRun[]): DeltaOp[] {
  const ops: DeltaOp[] = [];
  for (const run of runs) {
    if (run.type === "list") {
      for (const item of run.items) {
        if (item) ops.push({ insert: item });
        ops.push({ insert: "\n", attributes: { list: run.style } });
      }
      continue;
    }
    if (run.text) ops.push({ insert: run.text });
    if (run.type === "heading") ops.push({ insert: "\n", attributes: { header: run.level } });
    else ops.push({ insert: "\n" });
  }
  return ops;
}

function runsFromDelta(ops: DeltaOp[]): FeatureAnnouncementTextRun[] {
  const runs: FeatureAnnouncementTextRun[] = [];
  let line = "";

  const finishLine = (attributes?: DeltaAttributes) => {
    if (attributes?.header === 2 || attributes?.header === 3) {
      runs.push({ type: "heading", level: attributes.header, text: line });
    } else if (attributes?.list === "ordered" || attributes?.list === "bullet") {
      const previous = runs.at(-1);
      if (previous?.type === "list" && previous.style === attributes.list) previous.items.push(line);
      else runs.push({ type: "list", style: attributes.list, items: [line] });
    } else runs.push({ type: "paragraph", text: line });
    line = "";
  };

  for (const operation of ops) {
    if (typeof operation.insert !== "string") continue;
    const lines = operation.insert.split("\n");
    lines.forEach((part, index) => {
      line += part;
      if (index < lines.length - 1) finishLine(operation.attributes);
    });
  }

  if (line) finishLine();
  // Quill always keeps a final newline. It is an editor boundary, not an
  // intentional empty paragraph that should appear in the announcement.
  while (true) {
    const last = runs.at(-1);
    if (!last || last.type !== "paragraph" || last.text !== "") break;
    runs.pop();
  }
  return runs;
}

export default function FeatureAnnouncementEditor({
  announcementId,
  value,
  disabled,
  onChange,
  onError
}: {
  announcementId?: string;
  value: FeatureAnnouncementDraftBlock[];
  disabled: boolean;
  onChange: (blocks: FeatureAnnouncementDraftBlock[]) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const quill = useRef<QuillInstance | null>(null);
  const imageButton = useRef<HTMLButtonElement | null>(null);
  const imageInsertRange = useRef<{ index: number; length: number } | null>(null);
  const initialBlocks = useRef(value);
  const objectUrls = useRef(new Set<string>());
  const savedImages = useRef(new Map<string, ImageBlock>());
  const uploadedFiles = useRef(new Map<string, File>());
  const imageCount = useRef(value.filter((block) => block.type === "image").length);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const [loaded, setLoaded] = useState(false);
  const [images, setImages] = useState(value.filter((block) => block.type === "image").length);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);

  useEffect(() => {
    disabledRef.current = disabled;
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
    quill.current?.enable(!disabled);
    if (imageButton.current) imageButton.current.disabled = disabled;
  }, [disabled, onChange, onError]);

  useEffect(() => {
    let cancelled = false;
    let instance: QuillInstance | null = null;
    const editorHost = host.current;
    const urls = objectUrls.current;
    const savedImageMap = savedImages.current;
    const uploadedFileMap = uploadedFiles.current;
    const cleanupListeners = { current: () => {} };

    const initialize = async () => {
      const { default: QuillConstructor } = await import("quill");
      if (cancelled || !editorHost) return;

      if (!localImageBlotRegistered) {
        const ImageBlot = QuillConstructor.import("formats/image") as typeof import("quill/formats/image").default;
        class LocalImageBlot extends ImageBlot {
          static sanitize(url: string) {
            if (editorImageObjectUrls.has(url)) return url;
            return ImageBlot.sanitize(url);
          }
        }
        QuillConstructor.register("formats/image", LocalImageBlot, true);
        localImageBlotRegistered = true;
      }

      instance = new QuillConstructor(editorHost, {
        theme: "snow",
        placeholder: "Write the guide here. Use headings and lists to make steps easy to scan.",
        modules: {
          toolbar: {
            container: [
              [{ header: [2, 3, false] }],
              [{ list: "ordered" }, { list: "bullet" }],
              ["image"]
            ],
            handlers: {
              image: () => {
                if (disabledRef.current) return;
                imageInsertRange.current = quill.current?.getSelection() ?? null;
                fileInput.current?.click();
              }
            }
          }
        }
      });
      quill.current = instance;
      instance.root.setAttribute("aria-label", "Announcement guide text and images");
      instance.enable(!disabledRef.current);
      const toolbar = instance.root.closest(".ql-container")?.previousElementSibling;
      imageButton.current = toolbar?.querySelector<HTMLButtonElement>("button.ql-image") ?? null;
      imageButton.current?.setAttribute("aria-label", "Insert guide images");
      imageButton.current?.setAttribute("title", "Insert images at the cursor");
      toolbar?.querySelector<HTMLSelectElement>("select.ql-header")?.setAttribute("aria-label", "Text heading style");
      toolbar?.querySelectorAll<HTMLButtonElement>("button.ql-list").forEach((button) => {
        const kind = button.value === "ordered" ? "ordered" : "bulleted";
        button.setAttribute("aria-label", `${kind} list`);
        button.setAttribute("title", `${kind[0]!.toUpperCase()}${kind.slice(1)} list`);
      });
      if (imageButton.current) imageButton.current.disabled = disabledRef.current;

      const ops: DeltaOp[] = [];
      let loadedImageCount = 0;
      for (const block of initialBlocks.current) {
        if (cancelled) return;
        if (block.type === "text") {
          const richTextOps = block.runs?.length ? deltaFromRuns(block.runs) : [];
          if (richTextOps.length) ops.push(...richTextOps);
          else if (block.text) ops.push({ insert: block.text });
          continue;
        }

        let source = block.previewUrl;
        if (block.file) {
          source = createEditorImageUrl(block.file);
          urls.add(source);
        } else if (!source && block.imageId && announcementId) {
          try {
            const response = await fetchWithAuth(announcementImagePath(announcementId, block.imageId));
            if (!response.ok) throw new Error(`image request returned HTTP ${response.status}`);
            const blob = await response.blob();
            if (cancelled) return;
            source = createEditorImageUrl(blob);
            urls.add(source);
          } catch (cause) {
            if (cancelled) return;
            source = unavailableImageSource(block.imageId ?? "image");
            const reason = cause instanceof Error ? cause.message : "the image request failed";
            onErrorRef.current(`A saved guide image could not be previewed (${reason}). Its reference is preserved in this draft.`);
          }
        }
        if (!source) continue;
        const imageBlock: ImageBlock = { ...block, type: "image", previewUrl: source };
        if (block.imageId) savedImageMap.set(source, imageBlock);
        if (block.file) uploadedFileMap.set(source, block.file);
        ops.push({ insert: { image: source } });
        loadedImageCount += 1;
      }

      if (cancelled) return;
      if (!ops.length) ops.push({ insert: "\n" });
      const finalInsert = ops.at(-1)?.insert;
      if (typeof finalInsert !== "string" || !finalInsert.endsWith("\n")) ops.push({ insert: "\n" });
      const Delta = QuillConstructor.import("delta") as new (operations: DeltaOp[]) => ReturnType<QuillInstance["getContents"]>;
      instance.setContents(new Delta(ops), "silent");
      imageCount.current = loadedImageCount;
      setImages(loadedImageCount);
      setLoaded(true);

      const handleTextChange = (_delta: unknown, _oldDelta: unknown, source: string) => {
        if (source !== "user" || !instance) return;
        const blocks: FeatureAnnouncementDraftBlock[] = [];
        const pendingTextOps: DeltaOp[] = [];
        const unknownImageIndexes: number[] = [];
        let documentIndex = 0;
        const flushText = () => {
          const runs = runsFromDelta(pendingTextOps);
          if (runs.length) blocks.push(textBlockFromRuns(runs));
          pendingTextOps.length = 0;
        };

        for (const rawOperation of instance.getContents().ops ?? []) {
          const operation = rawOperation as DeltaOp;
          if (typeof operation.insert === "string") {
            pendingTextOps.push(operation);
            documentIndex += operation.insert.length;
            continue;
          }
          flushText();
          if (operation.insert && typeof operation.insert === "object" && "image" in operation.insert) {
            const sourceValue = operation.insert.image;
            const source = typeof sourceValue === "string" ? sourceValue : "";
            const saved = savedImageMap.get(source);
            const file = uploadedFileMap.get(source);
            if (saved) blocks.push({ type: "image", imageId: saved.imageId, alt: saved.alt });
            else if (file) {
              const fileName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
              blocks.push({ type: "image", file, alt: fileName.slice(0, 200) || "Guide screenshot", previewUrl: source });
            } else unknownImageIndexes.push(documentIndex);
          }
          documentIndex += 1;
        }
        flushText();
        if (!blocks.some((block) => block.type === "text")) blocks.push({ type: "text", text: "" });

        const hasUnknownImages = unknownImageIndexes.length > 0;
        if (hasUnknownImages) {
          for (const index of unknownImageIndexes.reverse()) instance.deleteText(index, 1, "api");
        }
        setSelectedImageIndex(null);
        imageCount.current = blocks.filter((block) => block.type === "image").length;
        setImages(imageCount.current);
        onChangeRef.current(blocks);
        if (hasUnknownImages) onErrorRef.current("Insert guide images with the image button so they can be securely uploaded.");
      };

      const handleSelectionChange = (range: { index: number; length: number } | null) => {
        if (!range || range.length !== 1 || !instance) {
          setSelectedImageIndex(null);
          return;
        }
        const selected = instance.getContents(range.index, 1).ops ?? [];
        const isImage = selected.some((operation) => typeof operation.insert === "object" && operation.insert !== null && "image" in operation.insert);
        setSelectedImageIndex(isImage ? range.index : null);
      };

      const handleEditorClick = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const image = event.target.closest(".ql-editor img");
        if (!image || !instance) {
          setSelectedImageIndex(null);
          return;
        }
        const blot = QuillConstructor.find(image);
        if (!blot) return;
        const index = instance.getIndex(blot as Parameters<QuillInstance["getIndex"]>[0]);
        instance.setSelection(index, 1, "silent");
        setSelectedImageIndex(index);
      };

      const handlePaste = (event: ClipboardEvent) => {
        if (event.clipboardData?.items && Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
          event.preventDefault();
          onErrorRef.current("Use the editor image button to add guide images.");
        }
      };

      instance.on("text-change", handleTextChange);
      instance.on("selection-change", handleSelectionChange);
      instance.root.addEventListener("click", handleEditorClick);
      instance.root.addEventListener("paste", handlePaste);
      cleanupListeners.current = () => {
        instance?.off("text-change", handleTextChange);
        instance?.off("selection-change", handleSelectionChange);
        instance?.root.removeEventListener("click", handleEditorClick);
        instance?.root.removeEventListener("paste", handlePaste);
      };
    };

    void initialize().catch(() => {
      if (!cancelled) onErrorRef.current("The guide editor could not be loaded. Refresh the page and try again.");
    });

    return () => {
      cancelled = true;
      cleanupListeners.current();
      quill.current = null;
      imageButton.current = null;
      for (const url of urls) URL.revokeObjectURL(url);
      for (const url of urls) editorImageObjectUrls.delete(url);
      urls.clear();
      savedImageMap.clear();
      uploadedFileMap.clear();
      editorHost?.replaceChildren();
    };
  }, [announcementId]);

  function removeSelectedImage() {
    const editor = quill.current;
    if (!editor || disabledRef.current || selectedImageIndex === null) return;
    editor.deleteText(selectedImageIndex, 1, "user");
    editor.setSelection(Math.min(selectedImageIndex, Math.max(0, editor.getLength() - 1)), 0, "silent");
    editor.focus();
    setSelectedImageIndex(null);
  }

  function addImages(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    if (files.length > 4 - imageCount.current) {
      onErrorRef.current("An announcement can include up to four images.");
      return;
    }
    if (files.some((file) => !allowedImageTypes.has(file.type))) {
      onErrorRef.current("Choose JPG, PNG, or WebP images.");
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) {
      onErrorRef.current("Each guide image must be 5 MB or smaller.");
      return;
    }

    const editor = quill.current;
    if (!editor || disabledRef.current) return;
    const range = imageInsertRange.current ?? editor.getSelection(true);
    imageInsertRange.current = null;
    let index = range?.index ?? Math.max(0, editor.getLength() - 1);
    if (range?.length) editor.deleteText(index, range.length, "user");
    for (const file of files) {
      const source = createEditorImageUrl(file);
      objectUrls.current.add(source);
      uploadedFiles.current.set(source, file);
      editor.insertEmbed(index, "image", source, "user");
      index += 1;
    }
    editor.setSelection(index, 0, "silent");
    editor.focus();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs leading-5 text-slate-500">
        <span>Insert images at the cursor · JPG, PNG, or WebP · 5 MB max each</span>
        <div className="flex items-center gap-3">
          <span className="shrink-0 font-medium tabular-nums">{images} / 4 images</span>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={removeSelectedImage}
            disabled={disabled || selectedImageIndex === null}
            title={selectedImageIndex === null ? "Select an image in the guide first" : "Remove selected image"}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            <FiTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Remove selected image
          </button>
        </div>
      </div>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addImages} disabled={disabled} className="sr-only" aria-label="Choose guide images to insert" />
      <div className="feature-announcement-editor mt-2 rounded-xl border border-slate-300 bg-white transition focus-within:border-[#0D1282] focus-within:ring-2 focus-within:ring-[#0D1282]/15" aria-busy={!loaded}>
        <div ref={host} />
        {!loaded ? <div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-500">Loading guide editor…</div> : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">To remove an uploaded image, select it in the guide and choose “Remove selected image”.</p>
    </div>
  );
}
