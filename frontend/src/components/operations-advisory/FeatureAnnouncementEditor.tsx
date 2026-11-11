"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type Quill from "quill";
import "quill/dist/quill.snow.css";
import { announcementImagePath, type FeatureAnnouncementDraftBlock } from "@/lib/featureAnnouncements";
import { fetchWithAuth } from "@/lib/shipmentsList";

type ImageBlock = Extract<FeatureAnnouncementDraftBlock, { type: "image" }>;
type QuillInstance = Quill;
type DeltaOp = { insert: string | { image: string } };

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
        placeholder: "Write the guide here. Use the image button to place screenshots between instructions.",
        modules: {
          toolbar: {
            container: [["image"]],
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
      imageButton.current = instance.root.closest(".ql-container")?.previousElementSibling?.querySelector<HTMLButtonElement>("button.ql-image") ?? null;
      imageButton.current?.setAttribute("aria-label", "Insert guide images");
      imageButton.current?.setAttribute("title", "Insert images at the cursor");
      if (imageButton.current) imageButton.current.disabled = disabledRef.current;

      const ops: DeltaOp[] = [];
      let loadedImageCount = 0;
      for (const block of initialBlocks.current) {
        if (cancelled) return;
        if (block.type === "text") {
          if (block.text) ops.push({ insert: block.text });
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
        const unknownImageIndexes: number[] = [];
        let documentIndex = 0;
        for (const operation of instance.getContents().ops ?? []) {
          if (typeof operation.insert === "string") {
            const last = blocks.at(-1);
            if (last?.type === "text") last.text += operation.insert;
            else blocks.push({ type: "text", text: operation.insert });
            documentIndex += operation.insert.length;
            continue;
          }
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

        const hasUnknownImages = unknownImageIndexes.length > 0;
        if (hasUnknownImages) {
          for (const index of unknownImageIndexes.reverse()) instance.deleteText(index, 1, "api");
        }
        if (!blocks.some((block) => block.type === "text")) blocks.push({ type: "text", text: "" });
        imageCount.current = blocks.filter((block) => block.type === "image").length;
        setImages(imageCount.current);
        onChangeRef.current(blocks);
        if (hasUnknownImages) onErrorRef.current("Insert guide images with the image button so they can be securely uploaded.");
      };
      instance.on("text-change", handleTextChange);
      instance.root.addEventListener("paste", (event) => {
        if (event.clipboardData?.items && Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
          event.preventDefault();
          onErrorRef.current("Use the editor image button to add guide images.");
        }
      });
      cleanupTextChange.current = () => { instance?.off("text-change", handleTextChange); };
    };

    const cleanupTextChange: { current: () => void } = { current: () => {} };
    void initialize().catch(() => {
      if (!cancelled) onErrorRef.current("The guide editor could not be loaded. Refresh the page and try again.");
    });

    return () => {
      cancelled = true;
      cleanupTextChange.current();
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
      <div className="flex items-center justify-between gap-3 text-xs leading-5 text-slate-500">
        <span>Insert images at the cursor · JPG, PNG, or WebP · 5 MB max each</span>
        <span className="shrink-0 font-medium tabular-nums">{images} / 4 images</span>
      </div>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addImages} disabled={disabled} className="sr-only" aria-label="Choose guide images to insert" />
      <div className="feature-announcement-editor mt-2 rounded-xl border border-slate-300 bg-white transition focus-within:border-[#0D1282] focus-within:ring-2 focus-within:ring-[#0D1282]/15" aria-busy={!loaded}>
        <div ref={host} />
        {!loaded ? <div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-500">Loading guide editor…</div> : null}
      </div>
    </div>
  );
}
