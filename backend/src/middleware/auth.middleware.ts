import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/auth.service.js";
import { User } from "../models/user.model.js";
import { normalizePortalRole } from "../utils/portalRole.js";
import { accountNotActiveMessage, touchSession, verifySession } from "../services/userSession.service.js";
import { isSoleSecurityLockedClient, securityLockMessage } from "../services/businessAccountSuspension.service.js";

export async function attachUser(req: Request, res: Response, next: NextFunction) {
  let tokenVerified = false;
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) return next();

    const token = header.replace("Bearer ", "");

    const payload = verifyAccessToken(token);
    tokenVerified = true;

    // A token whose session has been superseded, terminated or gone idle is
    // rejected outright rather than merely left unauthenticated: the client
    // needs the reason so it can say why the user was signed out, and a 401
    // with no explanation looks like an expired token it should silently
    // refresh.
    const sessionCheck = await verifySession(payload.sid);

    if (!sessionCheck.ok) {
      return res.status(401).json({ success: false, message: sessionCheck.message, sessionEnded: true });
    }

    const user = await User.findById(payload.sub)
      .select("email role name hasSeenWelcome assignedBranches userStatus")
      .lean()
      .exec();

    // A token outlives the account state it was minted from, so the status has
    // to be re-read on every request rather than trusted from login time.
    // Without this, suspending or disabling someone leaves their existing token
    // working- and since every refresh mints a fresh one, indefinitely.
    if (user && (user.userStatus ?? "active") !== "active") {
      return res.status(401).json({ success: false, message: accountNotActiveMessage, sessionEnded: true });
    }

    if (user && normalizePortalRole(user.role) === "client" && await isSoleSecurityLockedClient(user._id)) {
      return res.status(401).json({ success: false, message: securityLockMessage, sessionEnded: true });
    }

    if (user) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).user = { ...user, role: normalizePortalRole(user.role), sessionId: payload.sid };

      // Keeps the idle clock alive. Throttled inside, so this is not a database
      // write on every authenticated request.
      void touchSession(payload.sid);
    }
  } catch (error) {
    if (tokenVerified) return res.status(503).json({ success: false, message: "Account access could not be checked. Try again." });
    // Ignore an invalid token; protected routes still require authentication.
  }

  return next();
}

// Rejects anonymous requests without constraining the role. Use after attachUser
// on resources any signed-in user may read.
export function requireAuthenticated(req: Request, res: Response, next: NextFunction) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(req as any).user) return res.status(401).json({ success: false, message: "Unauthorized" });

  return next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (req as any).user;

    if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!roles.includes(user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return next();
  };
}
