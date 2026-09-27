import type { FastifyReply } from "fastify";
import { ApiErrorCode } from "@convo/shared";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, ApiErrorCode.ValidationError, msg, details);
export const unauthorized = (msg = "Authentication required") =>
  new AppError(401, ApiErrorCode.Unauthorized, msg);
export const forbidden = (msg = "Not allowed") =>
  new AppError(403, ApiErrorCode.Forbidden, msg);
export const notFound = (msg = "Not found") =>
  new AppError(404, ApiErrorCode.NotFound, msg);
export const conflict = (code: ApiErrorCode, msg: string) => new AppError(409, code, msg);
export const rateLimited = (msg = "Too many requests") =>
  new AppError(429, ApiErrorCode.RateLimited, msg);

export function sendError(reply: FastifyReply, err: AppError): void {
  void reply.status(err.statusCode).send({
    error: { code: err.code, message: err.message, details: err.details },
  });
}
