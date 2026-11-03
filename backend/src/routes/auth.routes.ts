import { Router } from "express";
import {
  activateInvitation,
  acceptOperatorClientInvitation,
  acceptOperatorInvitation,
  getInvitation,
  login,
  loginWithGoogle,
  logout,
  markWelcomeSeen,
  me,
  refresh,
  requestLoginOtp,
  requestPasswordReset,
  resetPassword,
  verifyLoginOtp
} from "../controllers/auth.controller.js";
import { attachUser, requireAuthenticated } from "../middleware/auth.middleware.js";
import { env } from "../config/env.js";
import { getMyClientWorkspaceAccess, listMyOperatorWorkspaces } from "../controllers/operatorWorkspace.controller.js";
import {
  googleLoginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  passwordLoginAccountLimiter,
  passwordLoginNetworkLimiter,
  passwordResetLimiter,
  passwordResetRequestLimiter
} from "../middleware/rateLimit.middleware.js";

export const authRouter = Router();

authRouter.post("/login", passwordLoginNetworkLimiter, passwordLoginAccountLimiter, login);
authRouter.post("/login/google", googleLoginLimiter, loginWithGoogle);
authRouter.post("/login/otp/request", otpRequestLimiter, requestLoginOtp);
authRouter.post("/login/otp/verify", otpVerifyLimiter, verifyLoginOtp);
authRouter.post("/logout", logout);
authRouter.post("/refresh", refresh);
authRouter.post("/forgot-password", passwordResetRequestLimiter, requestPasswordReset);
authRouter.post("/reset-password", passwordResetLimiter, resetPassword);
authRouter.get("/invitations/:token", getInvitation);
authRouter.post("/activate-invitation", activateInvitation);
authRouter.post("/accept-operator-invitation", attachUser, requireAuthenticated, acceptOperatorInvitation);
authRouter.post("/accept-operator-client-invitation", attachUser, requireAuthenticated, acceptOperatorClientInvitation);
authRouter.get("/me", attachUser, me);
authRouter.get("/client-workspaces", attachUser, requireAuthenticated, getMyClientWorkspaceAccess);
if (env.OPERATOR_PORTAL_ENABLED) {
  authRouter.get("/operator-workspaces", attachUser, requireAuthenticated, listMyOperatorWorkspaces);
}
authRouter.patch("/welcome-seen", attachUser, markWelcomeSeen);
