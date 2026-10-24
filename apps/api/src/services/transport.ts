import type { WsServerEvent } from "@convo/shared";
import type { RealtimeHub } from "./realtime.js";

/**
 * Transport abstraction layer (Stage 6): decouples message delivery from the
 * messaging core. Different transports handle different delivery mechanisms:
 * - WebSocket: realtime delivery to connected devices
 * - Push: native push notifications (FCM/APNs) for offline mobile devices
 * - Email: delivery to email identity recipients
 *
 * The messaging core calls `deliver()` without knowing which transport is
 * used. Each transport implements its own delivery logic, retry strategy,
 * and failure handling.
 */

/**
 * Common interface for all message transports. Each transport knows how to
 * deliver a message to a set of recipients using its specific mechanism.
 */
export interface MessageTransport {
  /** Unique identifier for this transport (e.g., "websocket", "push", "email"). */
  readonly name: string;

  /**
   * Deliver a message event to the specified recipients. Returns the set of
   * recipient IDs who successfully received the message. Transports should
   * handle their own retries and failures internally.
   */
  deliver(recipientIds: string[], event: WsServerEvent): Promise<string[]>;

  /**
   * Check if this transport can deliver to a specific recipient. Used by the
   * transport router to select the best transport for each recipient.
   */
  canDeliverTo(recipientId: string): Promise<boolean>;
}

/**
 * WebSocket transport: delivers messages in realtime to connected devices.
 * This is the primary transport for online users.
 */
export class WebSocketTransport implements MessageTransport {
  readonly name = "websocket";

  constructor(private readonly hub: RealtimeHub) {}

  async deliver(recipientIds: string[], event: WsServerEvent): Promise<string[]> {
    const delivered: string[] = [];
    for (const userId of recipientIds) {
      if (this.hub.isOnline(userId)) {
        this.hub.publishToUsers([userId], event);
        delivered.push(userId);
      }
    }
    return delivered;
  }

  async canDeliverTo(recipientId: string): Promise<boolean> {
    return this.hub.isOnline(recipientId);
  }
}

/**
 * Push notification transport: delivers messages to offline mobile devices
 * via FCM (Firebase Cloud Messaging) or APNs (Apple Push Notification service).
 * This transport is used when the WebSocket transport can't deliver (device offline).
 */
export class PushTransport implements MessageTransport {
  readonly name = "push";

  constructor(
    private readonly db: import("@prisma/client").PrismaClient,
    private readonly pushService?: PushNotificationService,
  ) {}

  async deliver(recipientIds: string[], event: WsServerEvent): Promise<string[]> {
    if (!this.pushService) return [];

    const delivered: string[] = [];
    for (const userId of recipientIds) {
      const devices = await this.db.device.findMany({
        where: { userId, status: "ACTIVE", pushToken: { not: null } },
        select: { pushToken: true, platform: true },
      });

      for (const device of devices) {
        if (!device.pushToken) continue;
        try {
          await this.pushService.send(device.pushToken, device.platform, event);
          delivered.push(userId);
          break; // One successful push per user is enough
        } catch (err) {
          // Log but continue to next device
          console.error(`[push] failed to send to ${userId}:`, err);
        }
      }
    }
    return delivered;
  }

  async canDeliverTo(recipientId: string): Promise<boolean> {
    const count = await this.db.device.count({
      where: { userId: recipientId, status: "ACTIVE", pushToken: { not: null } },
    });
    return count > 0;
  }
}

/**
 * Email transport: delivers messages to users who only have an email identity
 * (no phone number). This is used for the Convo-to-Convo Mail feature.
 */
export class EmailTransport implements MessageTransport {
  readonly name = "email";

  constructor(
    private readonly db: import("@prisma/client").PrismaClient,
    private readonly emailService?: EmailService,
  ) {}

  async deliver(recipientIds: string[], event: WsServerEvent): Promise<string[]> {
    if (!this.emailService) return [];

    const delivered: string[] = [];
    for (const userId of recipientIds) {
      const emailIdentity = await this.db.emailIdentity.findFirst({
        where: { userId },
        select: { email: true },
      });

      if (!emailIdentity) continue;

      try {
        await this.emailService.sendMessage(emailIdentity.email, event);
        delivered.push(userId);
      } catch (err) {
        console.error(`[email] failed to send to ${userId}:`, err);
      }
    }
    return delivered;
  }

  async canDeliverTo(recipientId: string): Promise<boolean> {
    const count = await this.db.emailIdentity.count({
      where: { userId: recipientId },
    });
    return count > 0;
  }
}

/**
 * Transport router: selects the best transport for each recipient and delivers
 * messages using the appropriate mechanism. Tries transports in priority order:
 * WebSocket (realtime) → Push (offline mobile) → Email (email-only users).
 */
export class TransportRouter {
  private readonly transports: MessageTransport[];

  constructor(
    private readonly hub: RealtimeHub,
    private readonly db: import("@prisma/client").PrismaClient,
    private readonly pushService?: PushNotificationService,
    private readonly emailService?: EmailService,
  ) {
    this.transports = [
      new WebSocketTransport(hub),
      new PushTransport(db, pushService),
      new EmailTransport(db, emailService),
    ];
  }

  /**
   * Deliver a message event to all recipients using the best available transport
   * for each. Returns a map of recipient ID → transport name used.
   */
  async deliver(recipientIds: string[], event: WsServerEvent): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const transport of this.transports) {
      const remaining = recipientIds.filter((id) => !results.has(id));
      if (remaining.length === 0) break;

      const canDeliver = await Promise.all(
        remaining.map(async (id) => ({ id, can: await transport.canDeliverTo(id) })),
      );
      const eligible = canDeliver.filter((r) => r.can).map((r) => r.id);

      if (eligible.length > 0) {
        const delivered = await transport.deliver(eligible, event);
        for (const userId of delivered) {
          results.set(userId, transport.name);
        }
      }
    }

    return results;
  }
}

/**
 * Push notification service interface. Implementations handle the specifics
 * of FCM (Firebase) or APNs (Apple) push notifications.
 */
export interface PushNotificationService {
  send(token: string, platform: string, event: WsServerEvent): Promise<void>;
}

/**
 * Email service interface. Implementations handle SMTP, SendGrid, SES, etc.
 */
export interface EmailService {
  sendMessage(to: string, event: WsServerEvent): Promise<void>;
}
