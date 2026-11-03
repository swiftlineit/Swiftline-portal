import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

export type PortalNotification = {
  id: string;
  businessAccountId: string | null;
  type: string;
  title: string;
  message: string;
  href: string;
  readAt: string | null;
  createdAt: string;
};

function notificationBasePath(operatorSlug?: string) {
  return operatorSlug
    ? `/api/v1/operators/${encodeURIComponent(operatorSlug)}/notifications`
    : "/api/v1/notifications";
}

async function request(path: string, init?: RequestInit) {
  let token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response = await fetch(apiUrl(path), { ...init, headers });
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
      response = await fetch(apiUrl(path), { ...init, headers });
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.message || "Notifications could not be loaded.");
  return data;
}

export async function listNotifications(operatorSlug?: string) {
  return request(notificationBasePath(operatorSlug)) as Promise<{
    success: true;
    notifications: PortalNotification[];
    unreadCount: number;
  }>;
}

export async function markNotificationRead(notificationId: string, operatorSlug?: string) {
  return request(`${notificationBasePath(operatorSlug)}/${encodeURIComponent(notificationId)}/read`, { method: "PATCH" });
}

export async function markAllNotificationsRead(operatorSlug?: string) {
  return request(`${notificationBasePath(operatorSlug)}/read-all`, { method: "PATCH" });
}
