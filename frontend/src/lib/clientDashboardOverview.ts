import { type ClientShipmentSummary } from "@/lib/clientDashboard";
import { listShipmentQuotes } from "@/lib/shipmentQuotes";
import { listSupportTickets } from "@/lib/supportTickets";

export type ClientStageTone = "stage" | "warning" | "critical";

export type ClientStageCount = {
  key: string;
  label: string;
  count: number;
  tone: ClientStageTone;
  step: number;
};

export type ClientMeter = {
  key: string;
  label: string;
  detail: string;
  count: number;
  total: number;
};

export type ClientTaskItem = {
  id: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  tone: "info" | "warning" | "critical";
};

export type ClientExtras = {
  quotesToConvert: number;
  ticketsAwaitingReply: number;
  unavailable: string[];
};

// The controller computes `readyForLabel`, `needsReview`, and `validationFailed`
// from mutually exclusive draft-status checks, but a draft moves on to booking
// once its label is created- so those three never sum to `totalShipments`.
// "In progress" is the remainder: drafts still short of ready-for-label that
// haven't hit an exception status either.
export function buildShipmentPipeline(summary: ClientShipmentSummary): ClientStageCount[] {
  const known = summary.readyForLabel + summary.needsReview + summary.validationFailed;
  const inProgress = Math.max(summary.totalShipments - known, 0);

  return [
    { key: "IN_PROGRESS", label: "In progress", count: inProgress, tone: "stage", step: 0 },
    { key: "READY", label: "Ready for label", count: summary.readyForLabel, tone: "stage", step: 1 },
    { key: "NEEDS_REVIEW", label: "Needs review", count: summary.needsReview, tone: "warning", step: 2 },
    { key: "VALIDATION_FAILED", label: "Validation failed", count: summary.validationFailed, tone: "critical", step: 2 }
  ];
}

// `addressValidated` and `labelsCreated` are independent flags that persist
// regardless of a draft's current status, so they read as completion ratios
// against the whole pool rather than as pipeline stages.
// export function buildCompletionMeters(summary: ClientShipmentSummary): ClientMeter[] {
//   return [
//     {
//       key: "ADDRESS_VALIDATED",
//       label: "Address validated",
//       detail: "Confirmed deliverable by the carrier",
//       count: summary.addressValidated,
//       total: summary.totalShipments
//     },
//     {
//       key: "LABELS_CREATED",
//       label: "Labels created",
//       detail: "Ready to hand over for collection",
//       count: summary.labelsCreated,
//       total: summary.totalShipments
//     }
//   ];
// }

// A rejected section must not blank the whole dashboard, so each source
// resolves to its value or the label of what could not be loaded.
async function safe<T>(label: string, task: () => Promise<T>): Promise<{ value: T | null; failed: string | null }> {
  try {
    return { value: await task(), failed: null };
  } catch {
    return { value: null, failed: label };
  }
}

export async function loadClientExtras(input: {
  canViewQuotes: boolean;
}): Promise<ClientExtras> {
  const [quotes, tickets] = await Promise.all([
    input.canViewQuotes ? safe("Quotes", () => listShipmentQuotes("client", { status: "QUOTED" })) : null,
    safe("Support tickets", () => listSupportTickets("client", { status: "WAITING_FOR_CUSTOMER", limit: 1 }))
  ]);

  const unavailable = [quotes, tickets]
    .map((result) => result?.failed)
    .filter((label): label is string => Boolean(label));

  return {
    quotesToConvert: quotes?.value?.pagination.total ?? 0,
    ticketsAwaitingReply: tickets?.value?.pagination.total ?? 0,
    unavailable: [...new Set(unavailable)]
  };
}

export function buildClientTasks(input: {
  summary: ClientShipmentSummary;
  extras: ClientExtras;
}): ClientTaskItem[] {
  const tasks: ClientTaskItem[] = [];
  const { summary, extras } = input;

  if (summary.validationFailed) {
    tasks.push({
      id: "validation-failed",
      label: "Shipments failed validation",
      detail: "Fix the flagged details to continue booking",
      count: summary.validationFailed,
      href: "/client/dpd-labels",
      tone: "critical"
    });
  }

  if (summary.needsReview) {
    tasks.push({
      id: "needs-review",
      label: "Shipments need your input",
      detail: "Address or documentation details are incomplete",
      count: summary.needsReview,
      href: "/client/dpd-labels",
      tone: "warning"
    });
  }

  if (extras.ticketsAwaitingReply) {
    tasks.push({
      id: "tickets",
      label: "Support tickets awaiting your reply",
      detail: "Our team is waiting on more details from you",
      count: extras.ticketsAwaitingReply,
      href: "/client/tickets",
      tone: "warning"
    });
  }

  if (extras.quotesToConvert) {
    tasks.push({
      id: "quotes",
      label: "Quotes ready to book",
      detail: "Convert a priced quote into a shipment",
      count: extras.quotesToConvert,
      href: "/client/quotes",
      tone: "info"
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return tasks.sort((left, right) => order[left.tone] - order[right.tone]);
}
