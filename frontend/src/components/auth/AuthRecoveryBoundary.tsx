"use client";

import { ReactNode, useCallback, useState } from "react";
import AuthRecoveryPage from "@/components/auth/AuthRecoveryPage";
import type { AuthRecoveryIssue } from "@/lib/authRecovery";
import { AuthRecoveryContext, type ReportAuthRecoveryIssue } from "@/contexts/AuthRecoveryContext";

export function AuthRecoveryBoundary({ children }: { children: ReactNode }) {
  const [issue, setIssue] = useState<AuthRecoveryIssue | null>(null);
  const reportIssue = useCallback<ReportAuthRecoveryIssue>((nextIssue) => setIssue(nextIssue), []);

  return (
    <AuthRecoveryContext.Provider value={reportIssue}>
      {issue
        ? <AuthRecoveryPage issue={issue} onRetry={() => setIssue(null)} />
        : children}
    </AuthRecoveryContext.Provider>
  );
}
