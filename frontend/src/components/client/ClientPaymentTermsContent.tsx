"use client";

import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import { getPaymentTerms, type PaymentTerms } from "@/lib/creditAccounts";
import { useClientUser } from "@/lib/useClientUser";

export default function ClientPaymentTermsContent() {
  const { user, loading: userLoading } = useClientUser();
  const [terms, setTerms] = useState<PaymentTerms | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    getPaymentTerms()
      .then((result) => setTerms(result.terms))
      .catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Payment terms could not be loaded."))
      .finally(() => setLoading(false));
  }, [user]);

  if (userLoading || !user) return <ClientDashboardLoading />;

  return (
    <article className="mx-auto max-w-4xl">
      <header className="border-b border-slate-200 bg-white px-6 py-7">
        <p className="text-xs font-semibold uppercase text-blue-900">Customer Agreement</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{terms?.title ?? "Payment Terms"}</h1>
        {terms ? <p className="mt-2 text-sm text-slate-500">Version {terms.version} | Effective {new Date(terms.effectiveFrom).toLocaleDateString("en-GB").replaceAll("/", "-")}</p> : null}
      </header>

      {loading ? <div className="border border-t-0 border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">Loading payment terms...</div> : null}
      {terms ? (
        <div className="border border-t-0 border-slate-200 bg-white px-6 py-2">
          {terms.sections.map((section) => (
            <section key={section.heading} className="border-b border-slate-100 py-5 last:border-b-0">
              <h2 className="text-base font-semibold text-slate-950">{section.heading}</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{section.content}</p>
            </section>
          ))}
        </div>
      ) : null}
    </article>
  );
}
