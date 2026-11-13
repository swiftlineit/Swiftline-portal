import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import type { IServiceDisruption } from "../models/serviceDisruption.model.js";
import { notifyPortalUsers } from "./portalNotification.service.js";

type DisruptionNotificationAction = "PUBLISHED" | "UPDATED";

/**
 * Publishes a service advisory to active client and internal operations users.
 * The saved advisory version is part of the idempotency key so every edit can
 * notify again while retries for that same save remain deduplicated.
 */
export async function dispatchServiceDisruptionNotification(
  disruption: Pick<IServiceDisruption, "_id" | "type" | "title" | "message" | "active" | "updatedAt">,
  action: DisruptionNotificationAction
) {
  if (!disruption.active) return;

  const recipients = await User.find({
    role: { $in: ["client", "admin", "operations"] },
    userStatus: "active"
  })
    .select("_id role")
    .lean()
    .exec();

  const clients = recipients.filter((recipient) => recipient.role === "client");
  const operationsUsers = recipients.filter((recipient) =>
    recipient.role === "admin" || recipient.role === "operations"
  );

  const versionKey = disruption.updatedAt.toISOString();
  const idempotencyKey = `SERVICE_DISRUPTION:${String(disruption._id)}:${versionKey}`;
  const emailTitle = `${action === "UPDATED" ? "Updated" : "New"} service advisory: ${disruption.title}`;
  const message = disruption.message.slice(0, 500);
  const metadata = {
    disruptionId: String(disruption._id),
    disruptionType: disruption.type
  };

  const audiences: Array<{
    userIds: mongoose.Types.ObjectId[];
    href: string;
  }> = [
    {
      userIds: clients.map((client) => client._id),
      href: "/client/operations-calendar"
    },
    {
      userIds: operationsUsers.map((user) => user._id),
      href: "/dashboard/operations-advisory?tab=disruptions"
    }
  ];

  for (const audience of audiences) {
    if (!audience.userIds.length) continue;

    await notifyPortalUsers(audience.userIds, {
      type: "SERVICE_DISRUPTION",
      title: disruption.title,
      message,
      href: audience.href,
      idempotencyKey,
      metadata,
      email: {
        subject: emailTitle,
        payload: { title: emailTitle }
      }
    });
  }
}
