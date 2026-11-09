"use client";

import { createContext, useContext } from "react";
import type { AuthRecoveryIssue } from "@/lib/authRecovery";

export type ReportAuthRecoveryIssue = (issue: AuthRecoveryIssue) => void;

export const AuthRecoveryContext = createContext<ReportAuthRecoveryIssue | null>(null);

export function useReportAuthRecoveryIssue() {
  return useContext(AuthRecoveryContext);
}
