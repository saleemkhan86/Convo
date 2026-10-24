import { ApiErrorCode } from "@convo/shared";
import { AppError } from "../lib/errors.js";
import type { OutgoingSms, SmsProvider, SmsSendResult } from "./provider.js";

/**
 * Selected in production when no vendor adapter is configured.
 *
 * Phone OTP is otherwise silently broken: the challenge row is written, the
 * client is told "code sent", and nothing ever arrives. Failing here turns that
 * into an immediate, explainable 503 at the endpoint instead.
 */
export class UnconfiguredSmsProvider implements SmsProvider {
  readonly name = "unconfigured";

  async sendSms(message: OutgoingSms): Promise<SmsSendResult> {
    throw new AppError(
      503,
      ApiErrorCode.Internal,
      `SMS delivery is not configured on this server, so a code cannot be sent to ${message.to}. Add a vendor adapter in src/sms/.`,
    );
  }
}
