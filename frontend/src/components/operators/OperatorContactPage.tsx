"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { FiArrowLeft, FiChevronDown, FiSend } from "react-icons/fi";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { getOperatorProfile } from "@/lib/profile";
import { submitOperatorContact, type OperatorContactInput } from "@/lib/operatorContact";

const field = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";
const label = "mb-1.5 block text-sm font-semibold text-slate-800";

export default function OperatorContactPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [input, setInput] = useState<OperatorContactInput>({
    kind: "HELP", subject: "", message: "", contactName: "", contactEmail: "", contactPhone: "", awbNumbers: []
  });
  const [awbs, setAwbs] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then(async (result) => {
      if (!active) return;
      setSession(result);
      if (result.membership.role !== "CLIENT" || result.access.readOnly) return;
      try {
        const profile = await getOperatorProfile(operatorSlug);
        if (active) setInput((current) => ({ ...current,
          contactName: profile.user.name || [profile.user.firstName, profile.user.lastName].filter(Boolean).join(" "),
          contactEmail: profile.user.email || "",
          contactPhone: profile.user.phone || ""
        }));
      } catch { /* Contact fields remain editable if the profile is unavailable. */ }
    }).catch((cause: unknown) => {
      if (!active) return;
      const canonical = (cause as { canonicalSlug?: unknown })?.canonicalSlug;
      if (typeof canonical === "string" && canonical !== operatorSlug) {
        router.replace(`/portal/${encodeURIComponent(canonical)}/contact`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to verify workspace access.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const awbNumbers = [...new Set(awbs.split(/[\s,]+/).map((awb) => awb.trim().toUpperCase()).filter(Boolean))];
    if (awbNumbers.length > 5 || awbNumbers.some((awb) => !/^[A-Z0-9-]{5,40}$/.test(awb))) {
      toast.error("Enter up to five valid AWB numbers, separated by commas or spaces.");
      return;
    }
    setSending(true);
    try {
      await submitOperatorContact(operatorSlug, { ...input, awbNumbers });
      setInput((current) => ({ ...current, kind: "HELP", subject: "", message: "", awbNumbers: [] }));
      setAwbs("");
      setSent(true);
      toast.success("Your message was sent to your operator.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to send your message.");
    } finally { setSending(false); }
  }

  if (loading) return <OperatorPageLoading label="Loading contact page" />;
  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  return <main className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] py-7 sm:py-10">
    <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Contact us</h1>
          <p className="mt-1 text-sm text-slate-600 sm:text-base">Send a question or report a shipment issue to your operator.</p></div>
        <Link href={base} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#0D1282] hover:bg-slate-50"><FiArrowLeft aria-hidden="true" /> Workspace home</Link>
      </div>
      {error || !session || session.membership.role !== "CLIENT" || session.access.readOnly
        ? <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700">{error || "This page is available to operator business account clients."}</div>
        : <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(240px,320px)] lg:items-start">
          <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="mb-6 border-b border-slate-200 pb-5"><h2 className="text-lg font-semibold text-slate-950">How can we help?</h2><p className="mt-1 text-sm text-slate-600">Your message goes directly to your operator team.</p></div>
            {sent ? <p role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">Message sent. Your operator team has been notified.</p> : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="contact-kind">Reason</label>
                <div className="relative">
                  <select id="contact-kind" value={input.kind} onChange={(event) => setInput({ ...input, kind: event.target.value as OperatorContactInput["kind"] })} className={`${field} appearance-none pr-12`}>
                    <option value="HELP">Ask for help</option>
                    <option value="ISSUE">Report an issue</option>
                  </select>
                  <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
                </div>
              </div>
              <div><label className={label} htmlFor="contact-subject">Subject</label><input id="contact-subject" className={field} required minLength={5} maxLength={120} value={input.subject} onChange={(event) => setInput({ ...input, subject: event.target.value })} placeholder="What is this about?" /></div>
              <div><label className={label} htmlFor="contact-name">Your name</label><input id="contact-name" className={field} required minLength={2} maxLength={160} autoComplete="name" value={input.contactName} onChange={(event) => setInput({ ...input, contactName: event.target.value })} /></div>
              <div><label className={label} htmlFor="contact-email">Email</label><input id="contact-email" className={field} type="email" required maxLength={320} autoComplete="email" value={input.contactEmail} onChange={(event) => setInput({ ...input, contactEmail: event.target.value })} /></div>
              <div><label className={label} htmlFor="contact-phone">Phone <span className="font-normal text-slate-500">(optional)</span></label><input id="contact-phone" className={field} type="tel" maxLength={30} autoComplete="tel" value={input.contactPhone} onChange={(event) => setInput({ ...input, contactPhone: event.target.value })} /></div>
              <div><label className={label} htmlFor="contact-awbs">AWB numbers <span className="font-normal text-slate-500">(optional)</span></label><input id="contact-awbs" className={field} value={awbs} onChange={(event) => setAwbs(event.target.value)} placeholder="Separate multiple AWBs with commas" aria-describedby="contact-awbs-hint" /><p id="contact-awbs-hint" className="mt-1 text-xs text-slate-500">Up to five shipments.</p></div>
            </div>
            <div className="mt-5"><label className={label} htmlFor="contact-message">Message</label><textarea id="contact-message" required minLength={10} maxLength={3000} rows={7} className={field + " resize-y"} value={input.message} onChange={(event) => setInput({ ...input, message: event.target.value })} placeholder="Tell us what you need help with." /><p className="mt-1 text-right text-xs text-slate-500">{input.message.length}/3000</p></div>
            <div className="mt-6 flex justify-end border-t border-slate-200 pt-5"><button disabled={sending} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0A106E] disabled:opacity-60 sm:w-auto"><FiSend aria-hidden="true" />{sending ? "Sending..." : "Send message"}</button></div>
          </form>
          <aside className="grid content-start gap-5 text-sm text-slate-600">
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="font-semibold text-slate-950">About your message</h2>
              <p className="mt-2 leading-6">Include an AWB number when your question is about a shipment. Your operator can reply using the contact details you provide.</p>
            </section>
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="font-semibold text-slate-950">Looking for a shipment?</h2>
              <p className="mt-2 leading-6">Check its latest status or open your shipment list before sending a question.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`${base}/tracking`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 font-semibold text-[#0D1282] hover:bg-slate-50">Track shipment</Link>
                <Link href={`${base}/shipments`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 font-semibold text-[#0D1282] hover:bg-slate-50">My shipments</Link>
              </div>
            </section>
          </aside>
        </div>}
    </div>
  </main>;
}
