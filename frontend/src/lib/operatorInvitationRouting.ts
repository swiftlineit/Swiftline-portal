/** Return only the operator-invitation activation path for a client login. */
export function getOperatorInvitationReturnPath(value: string | null, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";

  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/auth/activate" || !url.searchParams.get("token")) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

/** Return only a same-origin operator workspace path or invitation activation path for client sign-in. */
export function getClientLoginReturnPath(value: string | null, origin: string): string {
  const invitationPath = getOperatorInvitationReturnPath(value, origin);
  if (invitationPath) return invitationPath;
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";

  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin
      || url.pathname.includes("//")
      || /%(?:2f|5c)/i.test(url.pathname)
      || !/^\/portal\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/|$)/.test(url.pathname)
    ) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}
