import webpush from "web-push";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { NotificationType } from "@convo/shared";

/**
 * Push transports (Phase 5G).
 *
 * Two worlds: Expo's push service for the native apps (one batched POST for all
 * of a user's phones) and the browser Push API for web (one request per
 * subscription, encrypted with that subscription's own key). Both are fire and
 * forget: a notification that fails to push is still a row in the centre, so no
 * caller may await or branch on this.
 *
 * Credentials never leave the server. The only key a client ever sees is the
 * VAPID *public* key, which exists to be published — it is how a browser proves
 * to its push service that we, not some other site, sent the payload.
 */

/** Expo rejects a token that isn't shaped like one; a raw FCM token is not ours. */
const EXPO_TOKEN = /^ExponentPushToken\[[^\]]{8,128}\]$/;

export interface PushPayload {
  title: string;
  body: string | null;
  type: NotificationType;
  /** Replaces an earlier alert with the same tag instead of stacking one per message. */
  tag: string;
  /** Deep link. Must stay small: push services cap the payload. */
  data: Record<string, string>;
  /** Seconds a closed app may still be woken with this. */
  ttlSeconds: number;
}

export interface PushTransport {
  send(userId: string, payload: PushPayload): Promise<void>;
  /** The key a browser needs to subscribe; null when web push isn't configured. */
  vapidPublicKey(): string | null;
}

type DeviceRow = {
  id: string;
  pushToken: string | null;
  pushEndpoint: string | null;
  pushKeys: Prisma.JsonValue | null;
};

export function createPushTransport(db: PrismaClient, config: Config): PushTransport {
  let vapidConfigured = false;
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  }

  return {
    async send(userId, payload) {
      if (!config.PUSH_ENABLED) return;
      const devices = await db.device.findMany({
        where: { userId },
        select: { id: true, pushToken: true, pushEndpoint: true, pushKeys: true },
      });
      // One device failing must not cancel its siblings mid-flight.
      await Promise.allSettled(devices.map((device) => deliver(db, device, payload, config, vapidConfigured)));
    },
    vapidPublicKey: () => (vapidConfigured ? (config.VAPID_PUBLIC_KEY ?? null) : null),
  };
}

async function deliver(
  db: PrismaClient,
  device: DeviceRow,
  payload: PushPayload,
  config: Config,
  vapidConfigured: boolean,
): Promise<void> {
  const native = device.pushToken && EXPO_TOKEN.test(device.pushToken) ? device.pushToken : null;
  const web = device.pushEndpoint && vapidConfigured ? webSubscription(device) : null;
  if (native) await sendExpo(db, device.id, native, payload, config);
  if (web) await sendWebPush(db, device.id, web, payload);
}

/** ───────────────────────────── native (Expo) ───────────────────────────── */

async function sendExpo(
  db: PrismaClient,
  deviceId: string,
  token: string,
  payload: PushPayload,
  config: Config,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${config.EXPO_ACCESS_TOKEN}`;

  let response: Response;
  try {
    response = await fetch(config.EXPO_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify([expoMessage(token, payload)]),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return; // network trouble: the ticket is not lost, the next alert retries
  }
  if (!response.ok) return;

  const body = (await response.json().catch(() => null)) as
    | { data?: Array<{ status?: string; details?: { error?: string } }> }
    | null;
  const ticket = body?.data?.[0];
  // A token Expo no longer knows about will never work again; drop the
  // registration so the device list stops claiming push is on.
  if (ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
    await db.device.update({ where: { id: deviceId }, data: { pushToken: null } });
  }
}

function expoMessage(token: string, payload: PushPayload): Record<string, unknown> {
  return {
    to: token,
    title: payload.title,
    body: payload.body ?? undefined,
    collapseId: payload.tag,
    channelId: "convo-default",
    sound: "default",
    badge: 1,
    data: { type: payload.type, ...payload.data },
    ttl: payload.ttlSeconds * 1000,
  };
}

/** ───────────────────────────── web push ───────────────────────────── */

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function webSubscription(device: DeviceRow): Subscription | null {
  if (!device.pushEndpoint || !device.pushKeys || typeof device.pushKeys !== "object") return null;
  const keys = device.pushKeys as Record<string, unknown>;
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { endpoint: device.pushEndpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

async function sendWebPush(
  db: PrismaClient,
  deviceId: string,
  subscription: Subscription,
  payload: PushPayload,
): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify({ title: payload.title, body: payload.body, tag: payload.tag, data: payload.data }),
      { TTL: payload.ttlSeconds, headers: { Tag: payload.tag } },
    );
  } catch (err) {
    // 404/410 mean the subscription is gone (browser wiped it); anything else
    // may be transient, so the row stays.
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await db.device.update({ where: { id: deviceId }, data: { pushEndpoint: null, pushKeys: Prisma.JsonNull } });
    }
  }
}
