import { formatPaymentMoney } from "@/lib/paymentPresentation";

type Wallet = { availableBalanceMinor: number; cashBalanceMinor: number; reservedBalanceMinor: number; currency: string };

export default function WalletBalanceSummary({ wallet }: { wallet: Wallet }) {
  return (
    <section aria-label="Wallet balance" className="grid overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-[1.4fr_1fr_1fr]">
      <div className="px-5 py-5 sm:border-r sm:border-slate-200">
        <h2 className="text-sm font-medium text-slate-600">Available to book</h2>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">{formatPaymentMoney(wallet.availableBalanceMinor, wallet.currency)}</p>
      </div>
      <div className="border-t border-slate-200 px-5 py-5 sm:border-t-0">
        <h3 className="text-sm text-slate-600">Wallet total</h3>
        <p className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{formatPaymentMoney(wallet.cashBalanceMinor, wallet.currency)}</p>
      </div>
      <div className="border-t border-slate-200 px-5 py-5 sm:border-l sm:border-t-0">
        <h3 className="text-sm text-slate-600">Held for bookings</h3>
        <p className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{formatPaymentMoney(wallet.reservedBalanceMinor, wallet.currency)}</p>
      </div>
    </section>
  );
}
