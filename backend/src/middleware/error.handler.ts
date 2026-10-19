import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response
} from "express";
import { RateCardScopeError } from "../services/rateCardScope.service.js";

export const notFoundHandler = (
  request: Request,
  response: Response
): void => {
  response.status(404).json({
    success: false,
    message: `Route not found: ${request.method} ${request.originalUrl}`
  });
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
): void => {
  if (error instanceof RateCardScopeError) {
    response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error(error);

  response.status(500).json({
    success: false,
    message: "Internal server error"
  });
};
