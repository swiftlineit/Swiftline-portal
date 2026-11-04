"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowRight, FiLogOut, FiRefreshCw } from "react-icons/fi";
import { getClientWorkspaceAccess, type ClientWorkspaceAccess } from "@/lib/clientWorkspaceAccess";
import { logout } from "@/lib/auth";
import type { OperatorWorkspace } from "@/lib/operatorWorkspaces";
import { loadOperatorCompanyLogo } from "@/lib/operatorSettings";

function operatorRoleLabel(role: OperatorWorkspace["role"]) {
  switch (role) {
    case "OPERATOR_ADMIN": return "Operator administrator";
    case "FINANCE": return "Finance";
    case "OPERATIONS": return "Operations";
    case "CLIENT": return "Operator client";
  }
}

function getInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "WS";
}

function WorkspaceLogo({ name, src }: { name: string; src?: string }) {
  return (
    <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white">
      {src ? (
        <Image src={src} alt="" width={56} height={56} unoptimized className="h-full w-full object-contain p-1.5" />
      ) : (
        <span className="text-base font-bold tracking-wide text-[#0D1282]">{getInitials(name)}</span>
      )}
    </span>
  );
}

function WorkspaceLink({ href, name, description, logoUrl }: { href: string; name: string; description: string; logoUrl?: string }) {
  return (
    <Link href={href} className="group flex min-h-28 min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-[#0D1282]/40 hover:bg-[#0D1282]/[0.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:p-5">
      <WorkspaceLogo name={name} src={logoUrl} />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block break-words font-semibold leading-5 text-slate-950">{name}</span>
          <span className="mt-1.5 block text-sm text-slate-600">{description}</span>
        </span>
        <FiArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-[#0D1282]" />
      </span>
    </Link>
  );
}

export default function WorkspacesPage() {
  const router = useRouter();
  const [access, setAccess] = useState<ClientWorkspaceAccess | null>(null);
  const [operatorLogos, setOperatorLogos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const operatorWorkspaces = access?.operators;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAccess(await getClientWorkspaceAccess());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getClientWorkspaceAccess()
      .then((result) => { if (active) setAccess(result); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Workspace access could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const operators = operatorWorkspaces?.filter((workspace) => workspace.status === "ACTIVE") ?? [];
    const controller = new AbortController();
    let active = true;
    const objectUrls: string[] = [];

    void Promise.all(operators.map(async (workspace) => {
      try {
        const url = await loadOperatorCompanyLogo(workspace.slug, controller.signal);
        if (!url) return null;
        if (!active) {
          URL.revokeObjectURL(url);
          return null;
        }
        objectUrls.push(url);
        return [workspace.slug, url] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (!active) return;
      const logos: Record<string, string> = {};
      results.forEach((result) => {
        if (result) logos[result[0]] = result[1];
      });
      setOperatorLogos(logos);
    });

    return () => {
      active = false;
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [operatorWorkspaces]);

  async function handleSignOut() {
    await logout();
    router.replace("/");
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-[#F6F8FC] px-4 py-8 text-slate-900 sm:px-6 sm:py-12">
      <section className="mx-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-slate-200 px-5 py-6 sm:px-8 sm:py-7">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Choose workspace</h1>
            <p className="mt-1.5 text-sm leading-6 text-slate-600 sm:text-base">Select where you want to continue.</p>
          </div>
          <button type="button" onClick={() => void handleSignOut()} className="ml-auto inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
            <FiLogOut aria-hidden="true" className="h-4 w-4" /> Sign out
          </button>
        </header>

        <div className="p-4 sm:p-7">
          {loading ? (
            <p role="status" className="grid min-h-40 place-items-center px-4 py-8 text-center text-sm text-slate-600">Checking your workspace access…</p>
          ) : error ? (
            <div className="mx-auto max-w-xl rounded-lg border border-rose-200 bg-rose-50 p-4" role="alert">
              <p className="text-sm font-medium text-rose-900">{error}</p>
              <button type="button" onClick={() => void load()} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md border border-rose-300 bg-white px-3 text-sm font-semibold text-rose-900 hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700">
                <FiRefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
              </button>
            </div>
          ) : access ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {access.swiftline ? (
                <WorkspaceLink href="/client/dashboard" name="Swiftline client portal" description="Client portal" logoUrl="/slclogo1.png" />
              ) : null}
              {access.operators.map((workspace) => workspace.status === "ACTIVE" ? (
                <WorkspaceLink
                  key={workspace.slug}
                  href={`/portal/${encodeURIComponent(workspace.slug)}`}
                  name={workspace.companyName}
                  description={operatorRoleLabel(workspace.role)}
                  logoUrl={operatorLogos[workspace.slug]}
                />
              ) : (
                <div key={workspace.slug} className="flex min-h-28 min-w-0 items-center gap-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4 sm:p-5">
                  <WorkspaceLogo name={workspace.companyName} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold leading-5 text-slate-950">{workspace.companyName}</span>
                    <span className="mt-1.5 block text-sm text-slate-600">{operatorRoleLabel(workspace.role)}</span>
                    <span className="mt-2 inline-block text-xs font-semibold text-amber-800">Awaiting activation</span>
                  </span>
                </div>
              ))}
              {!access.swiftline && access.operators.length === 0 ? (
                <div className="grid min-h-40 place-items-center px-4 py-8 text-center sm:col-span-2">
                  <div>
                    <h2 className="font-semibold text-slate-900">No workspace access found</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">Check that you signed in with the invited email, or ask your business account administrator to confirm your access.</p>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
