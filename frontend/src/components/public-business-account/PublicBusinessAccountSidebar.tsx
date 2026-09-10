import { FiBriefcase, FiClock, FiFileText } from "react-icons/fi";

export default function PublicBusinessAccountSidebar() {
  return (
    <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
      <div className="flex h-full min-h-180 flex-col overflow-hidden rounded-xl border border-[#C7DADD] bg-white shadow-[0_12px_32px_rgba(15,23,42,0.06)] xl:min-h-190">
        <div className="relative flex h-67.5 shrink-0 items-center justify-center border-b border-[#C7DADD] bg-[#e22d30] px-4 py-5 xl:h-75">
          <img
            src="/business_account.png"
            alt="Business logistics"
            className="h-full w-full max-w-82.5 object-contain"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col bg-white px-6 py-6 xl:px-7 xl:py-7">
          <p className="text-xs font-semibold text-[#0D1282]">Swiftline Business Account</p>
          <h2 className="mt-2 text-[26px] font-bold leading-[1.18] tracking-tight text-slate-950 xl:text-[28px]">
            Create your business account
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Set up your account for business shipping, billing and account support. Complete the application and submit your KYC details for review.
          </p>

          <div className="mt-6 divide-y divide-[#D6E5E7] border-y border-[#D6E5E7]">
            <div className="flex items-center gap-3 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#DFF1F1] text-[#0D1282]">
                <FiClock className="h-4 w-4" />
              </span>
              <div>
                <p className="text-xs font-medium text-slate-500">Estimated time</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">About 10 minutes</p>
              </div>
            </div>

            <div className="flex items-center gap-3 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#DFF1F1] text-[#0D1282]">
                <FiFileText className="h-4 w-4" />
              </span>
              <div>
                <p className="text-xs font-medium text-slate-500">Keep ready</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">Aadhaar and PAN documents</p>
              </div>
            </div>

            <div className="flex items-center gap-3 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#DFF1F1] text-[#0D1282]">
                <FiBriefcase className="h-4 w-4" />
              </span>
              <div>
                <p className="text-xs font-medium text-slate-500">Keep ready</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">Company details</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
