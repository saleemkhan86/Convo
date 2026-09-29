import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ApiErrorCode } from "@convo/shared";
import type { AppDeps } from "./deps.js";
import { AppError, sendError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { conversationRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";
import { identityRoutes } from "./routes/identities.js";
import { mailRoutes } from "./routes/mail.js";
import { meRoutes } from "./routes/me.js";
import { wsRoutes } from "./routes/ws.js";

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.isProduction ? "info" : "debug",
    },
    trustProxy: deps.config.isProduction,
  });

  await app.register(cors, {
    origin: deps.config.CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });

  await app.register(jwt, {
    secret: deps.config.JWT_SECRET,
    sign: { algorithm: "HS256" },
  });

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"],
    errorResponseBuilder: () => ({
      error: {
        code: ApiErrorCode.RateLimited,
        message: "Too many requests. Please slow down.",
      },
    }),
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      sendError(reply, error);
      return;
    }
    if (error.statusCode === 429) {
      void reply.status(429).send({
        error: { code: ApiErrorCode.RateLimited, message: error.message },
      });
      return;
    }
    // Prisma unique constraint violation → conflict
    if (isPrismaUniqueViolation(error)) {
      void reply.status(409).send({
        error: { code: ApiErrorCode.Conflict, message: "Resource already exists" },
      });
      return;
    }
    request.log.error({ err: error }, "Unhandled error");
    void reply.status(500).send({
      error: {
        code: ApiErrorCode.Internal,
        message: deps.config.isProduction ? "Internal server error" : error.message,
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: { code: ApiErrorCode.NotFound, message: "Route not found" },
    });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, deps);
  await app.register(identityRoutes, deps);
  await app.register(meRoutes, deps);
  await app.register(conversationRoutes, deps);
  await app.register(mailRoutes, deps);
  await app.register(wsRoutes, deps);

  return app;
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}
