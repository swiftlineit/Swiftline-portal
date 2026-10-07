"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiChevronDown } from "react-icons/fi";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import {
  createTicketDraft,
  getTicketDraft,
  saveTicketDraft,
  submitTicketDraft,
} from "@/lib/supportTicketDrafts";
import { toast } from "react-toastify";
import {
  ClientDashboardLoading,
} from "@/components/client/ClientDashboardShell";
import {
  getClientDashboard,
  type ClientDashboardAccount,
} from "@/lib/clientDashboard";
import { listShipments, type ShipmentListItem } from "@/lib/shipmentsList";
import TicketShipmentContext from "@/components/tickets/TicketShipmentContext";
import {
  createSupportTicket,
  listSupportTickets,
  openTicketStatuses,
  requiresRelatedShipment,
  ticketCategories,
  type TicketCategory,
} from "@/lib/supportTickets";
import { useClientUser } from "@/lib/useClientUser";

function ticketDraftSnapshot(input: {
  businessAccountId: string;
  category: TicketCategory;
  relatedShipmentDraftId?: string | null;
  subject: string;
  description: string;
}) {
  return JSON.stringify({
    businessAccountId: input.businessAccountId,
    category: input.category,
    relatedShipmentDraftId: input.relatedShipmentDraftId ?? "",
    subject: input.subject.trim(),
    description: input.description.trim(),
  });
}

function NewSupportTicketForm() {
  const { user, loading } = useClientUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDraftId = searchParams.get("draftId");
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [draftVersion, setDraftVersion] = useState(1);
  const [accounts, setAccounts] = useState<ClientDashboardAccount[]>([]);
  const [shipments, setShipments] = useState<ShipmentListItem[]>([]);
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [category, setCategory] = useState<TicketCategory>("TRACKING_ISSUE");
  const [relatedShipmentDraftId, setRelatedShipmentDraftId] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // Shipments that already carry an unresolved ticket, so a second one is refused.
  const [blockedShipments, setBlockedShipments] = useState<
    Map<string, string>
  >(new Map());

  const currentSnapshot = useMemo(
    () => ticketDraftSnapshot({ businessAccountId, category, relatedShipmentDraftId, subject, description }),
    [businessAccountId, category, relatedShipmentDraftId, subject, description],
  );
  const hasUnsavedWork = !submitted && savedSnapshot !== null && currentSnapshot !== savedSnapshot;

  async function persistDraft() {
    if (!businessAccountId) throw new Error("Select a business account.");
    const payload = {
      businessAccountId,
      category,
      subject: subject.trim(),
      description: description.trim(),
      relatedShipmentDraftId: relatedShipmentDraftId || null,
    };
    if (draftId) {
      const updated = await saveTicketDraft(draftId, { ...payload, version: draftVersion });
      setDraftVersion(updated.version);
      setSavedSnapshot(ticketDraftSnapshot(payload));
      return updated;
    }
    const created = await createTicketDraft(payload);
    setDraftId(created.id);
    setDraftVersion(created.version);
    setSavedSnapshot(ticketDraftSnapshot(payload));
    // Keep URL in sync so a refresh resumes the same draft.
    router.replace(`/client/tickets/new?draftId=${encodeURIComponent(created.id)}`, { scroll: false });
    return created;
  }

  useUnsavedChanges(hasUnsavedWork, {
    label: "support ticket",
    saveDraft: async () => {
      await persistDraft();
      toast.success("Draft saved.");
    },
  });

  useEffect(() => {
    if (!user || !initialDraftId) return;
    void getTicketDraft(initialDraftId)
      .then((draft) => {
        setDraftId(draft.id);
        setDraftVersion(draft.version);
        setBusinessAccountId(draft.businessAccountId);
        setCategory(draft.category);
        setSubject(draft.subject ?? "");
        setDescription(draft.description ?? "");
        setRelatedShipmentDraftId(draft.relatedShipmentDraftId ?? "");
        setSavedSnapshot(ticketDraftSnapshot(draft));
      })
      .catch(() => toast.error("Could not load ticket draft."));
  }, [user, initialDraftId]);

  useEffect(() => {
    if (!user) return;
    getClientDashboard()
      .then((result) => {
        const active = result.accounts.filter(
          (item) => item.membership.status === "active",
        );
        setAccounts(active);
        if (active[0]) {
          setBusinessAccountId(active[0].account.id);
          if (!initialDraftId) {
            setSavedSnapshot(JSON.stringify({
              businessAccountId: active[0].account.id,
              category: "TRACKING_ISSUE",
              relatedShipmentDraftId: "",
              subject: "",
              description: "",
            }));
          }
        }
      })
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Business accounts could not be loaded.",
        ),
      )
      .finally(() => setPageLoading(false));
  }, [initialDraftId, user]);

  useEffect(() => {
    if (!businessAccountId) return;
    // The booked list rather than every draft: each shipment-linked category
    // describes a shipment already in motion, and this list is the one that
    // carries the status, last scan and service the panel below shows.
    void listShipments("client", { businessAccountId, limit: 50 })
      .then((result) => setShipments(result.shipments))
      .catch(() => setShipments([]));
  }, [businessAccountId]);

  // The server refuses a second ticket for a shipment that already has a live
  // one, so the same shipments are disabled here rather than failing on submit.
  useEffect(() => {
    if (!user) return;
    void listSupportTickets("client", { limit: 100 })
      .then((result) =>
        setBlockedShipments(
          new Map(
            result.tickets
              .filter(
                (ticket) =>
                  ticket.relatedShipmentDraftId &&
                  openTicketStatuses.includes(ticket.status),
              )
              .map((ticket) => [
                ticket.relatedShipmentDraftId as string,
                ticket.ticketNumber,
              ]),
          ),
        ),
      )
      .catch(() => setBlockedShipments(new Map()));
  }, [user]);

  const selectedAccount = useMemo(
    () => accounts.find((item) => item.account.id === businessAccountId),
    [accounts, businessAccountId],
  );
  const shipmentRequired = requiresRelatedShipment(category);
  const missingShipment = shipmentRequired && !relatedShipmentDraftId;
  // Mapped to the panel's own shape, and mapped the same way the server builds
  // it for an existing ticket, so the details do not shift once the ticket is
  // raised. Origin is the collecting branch; the list row carries no other one.
  const selectedShipment = useMemo(() => {
    const shipment = shipments.find((item) => item.id === relatedShipmentDraftId);
    if (!shipment) return null;
    return {
      awb: shipment.swiftlineTrackingNumber,
      origin: shipment.branch.name
        ? `${shipment.branch.name}${shipment.branch.code ? ` (${shipment.branch.code})` : ""}`
        : "",
      destination: shipment.destination,
      consignee: shipment.consignee,
      bookedAt: shipment.createdAt,
      statusLabel: shipment.statusLabel,
      lastScan: shipment.lastScan,
      service: shipment.serviceInfo,
    };
  }, [shipments, relatedShipmentDraftId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttemptedSubmit(true);
    setError("");
    if (
      !businessAccountId ||
      missingShipment ||
      subject.trim().length < 5 ||
      description.trim().length < 10
    )
      return;
    setSubmitting(true);
    try {
      const result = draftId
        ? await (async () => {
            await persistDraft();
            return submitTicketDraft(draftId);
          })()
        : await createSupportTicket({
            businessAccountId,
            category,
            subject,
            description,
            relatedShipmentDraftId: relatedShipmentDraftId || null,
          });
      setSubmitted(true);
      toast.success(`${result.ticket.ticketNumber} raised successfully.`);
      router.push(`/client/tickets/${result.ticket.id}`);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "The ticket could not be raised.";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user) return <ClientDashboardLoading />;
  return (
      <div className="mx-auto max-w-8xl">
        <div className="mt-4">
          <h1 className="text-2xl font-semibold text-slate-950">
            Raise Support Ticket
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Provide the relevant details so Swiftline can route your request
            correctly.
          </p>
        </div>
        {error ? (
          <div className="mt-5 border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}
        <form
          onSubmit={submit}
          className="mt-6 border border-slate-300 bg-white rounded-2xl"
        >
          <div className="border-b border-slate-200 px-6 py-5">
            <h2 className="font-semibold text-slate-950">Request Details</h2>
            <p className="mt-1 text-sm text-slate-500">
              Fields marked with an asterisk are required.
            </p>
          </div>
          <div className="grid gap-5 p-6 md:grid-cols-2">
            <Field
              label="Business Account"
              required
              error={
                attemptedSubmit && !businessAccountId
                  ? "Select a business account."
                  : ""
              }
            >
              <div className="relative">
                <select
                  value={businessAccountId}
                  disabled={pageLoading}
                  onChange={(event) => {
                    setBusinessAccountId(event.target.value);
                    setRelatedShipmentDraftId("");
                    setShipments([]);
                  }}
                  className="h-11 w-full appearance-none border rounded-xl border-slate-300 bg-white px-3 pr-9 text-sm focus:border-blue-900 focus:outline-none"
                >
                  <option value="">Select business account</option>
                  {accounts.map((item) => (
                    <option key={item.account.id} value={item.account.id}>
                      {item.account.company.companyName} ({item.account.accountId}
                      )
                    </option>
                  ))}
                </select>
                <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </Field>
            <Field label="Assigned Branch">
              <div className="flex h-11 items-center  rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700">
                {selectedAccount?.account.assignedBranch
                  ? `${selectedAccount.account.assignedBranch.name} (${selectedAccount.account.assignedBranch.code})`
                  : "Assigned automatically"}
              </div>
            </Field>
            <Field label="Category" required>
              <div className="relative">
                <select
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as TicketCategory)
                  }
                  className="h-11 w-full appearance-none border rounded-xl border-slate-300 bg-white px-3 pr-9 text-sm focus:border-blue-900 focus:outline-none"
                >
                  {ticketCategories.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </Field>
            <Field
              label="Related Shipment"
              required={shipmentRequired}
              error={
                attemptedSubmit && missingShipment
                  ? "Select the shipment this issue relates to."
                  : ""
              }
            >
              <div className="relative">
                <select
                  value={relatedShipmentDraftId}
                  onChange={(event) =>
                    setRelatedShipmentDraftId(event.target.value)
                  }
                  className="h-11 w-full appearance-none border border-slate-300 rounded-xl bg-white px-3 pr-9 text-sm focus:border-blue-900 focus:outline-none"
                >
                  <option value="">Select a Shipment</option>
                  {shipments.map((shipment) => {
                    const openTicket = blockedShipments.get(shipment.id);
                    const draftConsignee = shipment.consignee || "Shipment";
                    const label = shipment.swiftlineTrackingNumber
                      || `AWB Pending - ${draftConsignee}`;
                    return (
                      <option
                        key={shipment.id}
                        value={shipment.id}
                        disabled={Boolean(openTicket)}
                      >
                        {openTicket ? `${label}- ${openTicket} open` : label}
                      </option>
                    );
                  })}
                </select>
                <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              {/* Picking an AWB shows what it is, so neither the customer nor
                  the agent has to look the shipment up separately. */}
              {selectedShipment ? (
                <div className="mt-3">
                  <TicketShipmentContext shipment={selectedShipment} />
                </div>
              ) : null}

              {shipmentRequired ? (
                <span className="mt-1 block text-xs text-slate-500">
                  Shipments with a ticket still in progress cannot be selected.
                </span>
              ) : null}
            </Field>
            <div className="md:col-span-2">
              <Field
                label="Subject"
                required
                error={
                  attemptedSubmit && subject.trim().length < 5
                    ? "Enter at least 5 characters."
                    : ""
                }
              >
                <input
                  value={subject}
                  maxLength={120}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="Short summary of the issue"
                  className="h-11 w-full border rounded-xl border-slate-300 px-3 text-sm focus:border-blue-900 focus:outline-none"
                />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field
                label="Description"
                required
                error={
                  attemptedSubmit && description.trim().length < 10
                    ? "Enter at least 10 characters."
                    : ""
                }
              >
                <textarea
                  value={description}
                  maxLength={2000}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Explain what happened, what you expected, and any useful shipment or payment details."
                  rows={7}
                  className="w-full resize-y rounded-2xl border border-slate-300 p-3 text-sm focus:border-blue-900 focus:outline-none"
                />
                <p className="mt-1 text-right text-xs text-slate-400">
                  {description.length}/2000
                </p>
              </Field>
            </div>
          </div>
          <div className="flex justify-between border-t border-slate-200 px-6 py-4">
            <button
              type="button"
              disabled={submitting || savingDraft || pageLoading || !businessAccountId}
              onClick={() => {
                setSavingDraft(true);
                void persistDraft()
                  .then(() => toast.success("Draft saved."))
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Draft could not be saved."))
                  .finally(() => setSavingDraft(false));
              }}
              className="inline-flex h-11 items-center gap-2 rounded-4xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282] disabled:opacity-50"
            >
              {savingDraft ? "Saving..." : "Save Draft"}
            </button>
            <button
              disabled={submitting || pageLoading}
              className="inline-flex h-11 items-center gap-2 bg-blue-950 px-5 rounded-4xl text-sm font-semibold text-white hover:bg-blue-900 disabled:bg-slate-400"
            >
              {submitting ? "Submitting..." : "Raise Ticket"}
            </button>
          </div>
        </form>
      </div>
  );
}

export default function NewSupportTicketPage() {
  return (
    <Suspense fallback={<ClientDashboardLoading />}>
      <NewSupportTicketForm />
    </Suspense>
  );
}

function Field({
  label,
  required = false,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-600">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </span>
      <div className="mt-2">{children}</div>
      {error ? (
        <span className=" mt-1 block text-xs font-medium text-red-600">
          {error}
        </span>
      ) : null}
    </label>
  );
}
