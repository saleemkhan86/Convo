import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  connectIdentityRequestSchema,
  emailAddressSchema,
  e164PhoneSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import type { UserWithIdentities } from "../services/account.js";
import {
  requestConnectEmail,
  requestConnectPhone,
  verifyConnectEmail,
  verifyConnectPhone,
} from "../services/identity.js";

export async function identityRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  const ctx = (req: { ip: string }) => ({ ip: req.ip });

  // Flow E: "Connect Email" — attaches an email identity to THIS account.
  app.post(
    "/identities/email/request-otp",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      const { email } = parse(z.object({ email: emailAddressSchema }), request.body);
      return requestConnectEmail(deps, user, email, ctx(request));
    },
  );

  app.post(
    "/identities/email/verify-otp",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      const body = parse(connectIdentityRequestSchema, request.body);
      return verifyConnectEmail(deps, user, body, ctx(request));
    },
  );

  // Flow E: "Connect Phone Number" — attaches a phone identity to THIS account.
  app.post(
    "/identities/phone/request-otp",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      const { phone } = parse(z.object({ phone: e164PhoneSchema }), request.body);
      return requestConnectPhone(deps, user, phone, ctx(request));
    },
  );

  app.post(
    "/identities/phone/verify-otp",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      const body = parse(connectIdentityRequestSchema, request.body);
      return verifyConnectPhone(deps, user, body, ctx(request));
    },
  );
}

function requireUser(request: FastifyRequest): UserWithIdentities {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser;
}
