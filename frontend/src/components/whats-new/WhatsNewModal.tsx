"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FiArrowLeft, FiArrowRight, FiPlay, FiX } from "react-icons/fi";
import { embeddableVideoUrl, type FeatureAnnouncement } from "@/lib/featureAnnouncements";
import { useGuardedNavigate } from "@/lib/useUnsavedChanges";
import AnnouncementImage from "./AnnouncementImage";

export default function WhatsNewModal({ items, onSeen, onClose, preview = false }: {
  items: FeatureAnnouncement[];
  onSeen: (item: FeatureAnnouncement) => Promise<void>;
  onClose: () => void;
  preview?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [playVideo, setPlayVideo] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const guardNavigate = useGuardedNavigate();
  const closeButton = useRef<HTMLButtonElement>(null);
  const item = items[index];

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = priorOverflow; previous?.focus(); };
  }, []);

  useEffect(() => {
    if (item) void onSeen(item);
  }, [item, onSeen]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!item) return null;
  const videoUrl = embeddableVideoUrl(item.videoUrl);
  const advance = (next: number) => { setPlayVideo(false); setIndex(next); closeButton.current?.focus(); };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0A1038]/70 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="whats-new-title" aria-describedby="whats-new-summary" className="flex max-h-[min(92dvh,900px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-[#F0DE36] px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-[#12185A]">New</span>
            <span className="text-sm font-medium text-slate-500">What&apos;s new · {index + 1} of {items.length}</span>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="Close what's new" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiX aria-hidden="true" className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-6 [scrollbar-color:#94a3b8_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400 sm:px-9 sm:py-8">
          <h2 id="whats-new-title" className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{item.title}</h2>
          <p id="whats-new-summary" className="mt-3 text-base font-medium leading-relaxed text-slate-700">{item.summary}</p>
          <div className="mt-6 space-y-5">
            {item.contentBlocks?.length ? item.contentBlocks.map((block, blockIndex) => block.type === "image" ? (
              <AnnouncementImage key={`${block.imageId}-${blockIndex}`} announcementId={item.id} imageId={block.imageId} alt={block.alt} previewUrl={block.previewUrl} />
            ) : block.text.trim() ? (
              <p key={`text-${blockIndex}`} className="whitespace-pre-line text-sm leading-7 text-slate-600">{block.text}</p>
            ) : null) : <p className="whitespace-pre-line text-sm leading-7 text-slate-600">{item.body}</p>}
          </div>
          {videoUrl ? (
            <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-[#12185A]">
              {playVideo ? <div className="aspect-video"><iframe title={`${item.title} tutorial video`} src={videoUrl} sandbox="allow-scripts allow-same-origin allow-presentation" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen className="h-full w-full" /></div> :
                <button type="button" onClick={() => setPlayVideo(true)} className="flex aspect-video w-full flex-col items-center justify-center gap-3 text-white hover:bg-[#252B83] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[#F0DE36]"><span className="rounded-full bg-white p-4 text-[#12185A]"><FiPlay aria-hidden="true" className="h-6 w-6" /></span><span className="text-sm font-semibold">Play tutorial video</span></button>}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-5 py-4 sm:px-7">
          {preview ? <span className="text-sm font-medium text-slate-500">Preview · opens {item.targetHref}</span> : <Link href={item.targetHref} onNavigate={guardNavigate(item.targetHref)} onClick={onClose} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#252B83] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">Open feature <FiArrowRight aria-hidden="true" className="ml-2 h-4 w-4" /></Link>}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => advance(index - 1)} disabled={index === 0} aria-label="Previous update" className="rounded-lg border border-slate-200 p-2.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[#0D1282]"><FiArrowLeft aria-hidden="true" /></button>
            {index < items.length - 1 ? <button type="button" onClick={() => advance(index + 1)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">Next <FiArrowRight aria-hidden="true" /></button> : <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[#0D1282]">Done</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
