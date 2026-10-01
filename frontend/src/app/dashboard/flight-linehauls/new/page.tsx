"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DashboardLoading } from "@/components/DashboardShell";

/** Flight setup now starts from the combined manifest and flight form. */
export default function NewFlightPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/operations-manifests/new");
  }, [router]);

  return <DashboardLoading />;
}
