import { redirect } from "next/navigation";

export default function ClientCreditLedgerPage() {
  redirect("/client/payments#wallet-ledger");
}
