import type { FastifyInstance } from "fastify";
import {
  refreshRequestSchema,
  requestEmailOtpRequestSchema,
  requestPhoneOtpRequestSchema,
  verifyEmailOtpRequestSchema,
  verifyPhoneOtpRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { parse } from "../lib/validation.js";
import type { AuthDeps } from "../services/auth.js";
import { logout, refreshSession, requestEmailOtp, requestPhoneOtp, verifyLoginOtp } from "../services/auth.js";

const OTP_REQUEST_LIMIT = { max: 5, timeWindow: "1 minute" as const };
const OTP_VERIFY_LIMIT = { max: 10, timeWindow: "1 minute" as const };

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const loginCtx = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    deviceInfo: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 255) : undefined,
  });

  app.post(
    "/auth/phone/request-otp",
    { config: { rateLimit: OTP_REQUEST_LIMIT } },
    async (request) => {
      const { phone } = parse(requestPhoneOtpRequestSchema, request.body);
      return requestPhoneOtp(depsToAuth(deps, app), phone, loginCtx(request));
    },
  );

  app.post(
    "/auth/phone/verify-otp",
    { config: { rateLimit: OTP_VERIFY_LIMIT } },
    async (request) => {
      const body = parse(verifyPhoneOtpRequestSchema, request.body);
      return verifyLoginOtp(depsToAuth(deps, app), body, loginCtx(request));
    },
  );

  app.post(
    "/auth/email/request-otp",
    { config: { rateLimit: OTP_REQUEST_LIMIT } },
    async (request) => {
      const { email } = parse(requestEmailOtpRequestSchema, request.body);
      return requestEmailOtp(depsToAuth(deps, app), email, loginCtx(request));
    },
  );

  app.post(
    "/auth/email/verify-otp",
    { config: { rateLimit: OTP_VERIFY_LIMIT } },
    async (request) => {
      const body = parse(verifyEmailOtpRequestSchema, request.body);
      return verifyLoginOtp(depsToAuth(deps, app), body, loginCtx(request));
    },
  );

  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { refreshToken } = parse(refreshRequestSchema, request.body);
      return refreshSession(depsToAuth(deps, app), refreshToken, loginCtx(request));
    },
  );

  app.post("/auth/logout", async (request) => {
    const { refreshToken } = parse(refreshRequestSchema, request.body);
    await logout(depsToAuth(deps, app), refreshToken);
    return { ok: true };
  });
}

function depsToAuth(deps: AppDeps, app: FastifyInstance): AuthDeps {
  return { db: deps.db, config: deps.config, email: deps.email, jwt: app };
}
