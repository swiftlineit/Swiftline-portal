"use client";

import Link from "next/link";
import { FiArrowRight } from "react-icons/fi";
import type { ClientDashboardAccount } from "@/lib/clientDashboard";
import {
  canCreateShipment,
  canMakePayment,
  canRequestQuote,
  hasQuoteAccess,
} from "@/components/client/dashboard/clientDashboardPermissions";

export default function ClientQuickAccess({
  account,
}: {
  account: ClientDashboardAccount;
}) {
  const financialAccess = canMakePayment(account);

  const quickAccess = [
 
   
    {
      label: "Create Shipment",
      description: "Book a shipment and get a tracking number",
      href: "/client/dpd-labels",
      show:true,
    },
 
  
    {
      label: "Support Tickets",
      description: "Message our team about a shipment",
      href: "/client/tickets",
      show: true,
    },
    {
      label: "Credit Account",
      description: "View your facility and request a limit",
      href: "/client/credit",
      show: true,
    },
    {
      label: "invite Team Members",
      description: "invite your colleagues to manage shipments",
      href: "/client/team",
      show: financialAccess,
    },
    
  ].filter((item) => item.show);

  return (
    <section className=" rounded-lg bg-white p-4 shadow-sm sm:px-5">
     

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {quickAccess.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-[#03AED2] text-slate-200 px-3 py-2.5 transition-all shadow-sm duration-200 hover:border-[#0D1282]/25 hover:bg-white hover:text-black hover:shadow-[0_8px_20px_-14px_rgba(13,18,130,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/20 focus-visible:ring-offset-2"
          >
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-white transition-colors duration-200 group-hover:text-[#0D1282]">
                {item.label}
              </h3>
              <p className="mt-0.5 truncate text-[12.5px] ">
                {item.description}
              </p>
            </div>

            <FiArrowRight
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-[#0D1282]"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}