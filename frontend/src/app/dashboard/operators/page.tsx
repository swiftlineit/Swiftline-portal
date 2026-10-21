import { notFound } from "next/navigation";
import OperatorRegistry from "@/components/operators/OperatorRegistry";

export default function OperatorsPage() {
  if (process.env.NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED !== "true") notFound();
  return <OperatorRegistry />;
}
