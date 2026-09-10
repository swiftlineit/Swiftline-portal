import type { ReactNode } from "react";

export default function PublicPolicyPage({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="bg-[#0D1282] text-white">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#F5B942]">
            {eyebrow}
          </p>
          <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-white/75">
            {summary}
          </p>
          <p className="mt-6 text-xs text-white/55">
            Effective and last updated: 8 September 2026
          </p>
        </div>
      </header>
      <article className="prose mx-auto max-w-3xl px-4 py-12 text-sm leading-7 text-slate-600 sm:px-6 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-slate-950 [&_h3]:mt-6 [&_h3]:font-bold [&_h3]:text-slate-900 [&_li]:mt-2 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:mt-4">
        {children}
      </article>
    </>
  );
}
