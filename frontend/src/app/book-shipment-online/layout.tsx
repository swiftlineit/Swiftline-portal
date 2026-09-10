import PublicFooter from "@/components/public/PublicFooter";
import PublicHeader from "@/components/public/PublicHeader";

export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen w-full flex-col overflow-x-clip bg-slate-50"><PublicHeader /><main className="w-full min-w-0 flex-1">{children}</main><PublicFooter /></div>;
}
