import PublicFooter from "@/components/public/PublicFooter";
import PublicHeader from "@/components/public/PublicHeader";

export default function PublicPolicyLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-white"><PublicHeader /><main className="flex-1">{children}</main><PublicFooter /></div>;
}
