"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { announcementImagePath } from "@/lib/featureAnnouncements";
import { fetchWithAuth } from "@/lib/shipmentsList";

export default function AnnouncementImage({ announcementId, imageId, alt, previewUrl }: {
  announcementId: string;
  imageId: string;
  alt: string;
  previewUrl?: string;
}) {
  const sourceKey = `${announcementId}:${imageId}:${previewUrl ?? ""}`;
  const [loadedImage, setLoadedImage] = useState<{ key: string; source: string; failed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (previewUrl) return () => { cancelled = true; };

    void fetchWithAuth(announcementImagePath(announcementId, imageId))
      .then(async (response) => {
        if (!response.ok) throw new Error("Guide image is unavailable.");
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setLoadedImage({ key: sourceKey, source: objectUrl, failed: false });
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (!cancelled) setLoadedImage({ key: sourceKey, source: "", failed: true }); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [announcementId, imageId, previewUrl, sourceKey]);

  const source = previewUrl ?? (loadedImage?.key === sourceKey ? loadedImage.source : null);
  const failed = loadedImage?.key === sourceKey && loadedImage.failed;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-100">
      {source ? <Image src={source} alt={alt} fill unoptimized sizes="(max-width: 768px) 100vw, 900px" className="object-cover" /> : (
        <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500" role={failed ? "status" : undefined}>
          {failed ? "This guide image is unavailable." : "Loading guide image…"}
        </div>
      )}
    </div>
  );
}
