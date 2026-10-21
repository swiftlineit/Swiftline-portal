import { Router } from "express";
import { getOperatorSession } from "../controllers/operatorSession.controller.js";
import { attachUser } from "../middleware/auth.middleware.js";
import { requireOperatorContext } from "../middleware/operatorContext.middleware.js";

export const operatorRouter = Router({ mergeParams: true });

operatorRouter.use(attachUser, requireOperatorContext);
operatorRouter.get("/me", getOperatorSession);
