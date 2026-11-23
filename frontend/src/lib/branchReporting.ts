import { requestJson } from "@/lib/shipmentsList";

export type BranchWalletRow = {
  id: string;
  businessAccountId: string;
  accountId: string;
  companyName: string;
  status: string;
  walletBalanceMinor: number;
  reservedBalanceMinor: number;
  availableBalanceMinor: number;
};

export type BranchFinanceSummary = {
  period: { from: string; to: string };
  currency: string;
  business: {
    shipments: number;
    invoicedMinor: number;
    linkedAccounts: number;
    walletCount: number;
    walletBalanceMinor: number;
    reservedBalanceMinor: number;
    availableBalanceMinor: number;
    wallets: BranchWalletRow[];
  };
  individual: {
    shipments: number;
    collectedMinor: number;
    refundedMinor: number;
    netMinor: number;
    methods: Array<{
      method: "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
      collectedMinor: number;
      refundedMinor: number;
      netMinor: number;
    }>;
    recentPayments: Array<{
      id: string;
      shipmentDraftId: string;
      trackingNumber: string;
      customerName: string;
      customerMobile: string;
      direction: "COLLECTED" | "REFUNDED";
      amountMinor: number;
      method: "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
      reference: string;
      recordedBy: string;
      recordedAt: string;
    }>;
  };
};

export type BranchUserRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  kind: "BUSINESS_ACCOUNT" | "INTERNAL_STAFF" | "ADMINISTRATOR";
  role: string;
  organization: string;
  accountId?: string;
  branchAccess: "ASSIGNED" | "INHERITED" | "GLOBAL";
  accessStatus: string;
  loginStatus: string;
  lastLogin: string | null;
  detailId: string;
};

export type BranchUsersResult = {
  users: BranchUserRow[];
  totals: {
    all: number;
    businessAccounts: number;
    internalStaff: number;
    administrators: number;
    active: number;
    inactive: number;
  };
};

export async function getBranchFinanceSummary(branchId: string, from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  return requestJson<{ success: true } & BranchFinanceSummary>(
    `/api/v1/branches/${encodeURIComponent(branchId)}/finance-summary?${query.toString()}`
  );
}

export async function getBranchUsers(branchId: string) {
  return requestJson<{ success: true } & BranchUsersResult>(
    `/api/v1/branches/${encodeURIComponent(branchId)}/users`
  );
}
