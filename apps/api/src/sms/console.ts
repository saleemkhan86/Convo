import type { OutgoingSms, SmsProvider, SmsSendResult } from "./provider.js";

/**
 * Development fallback: logs the message instead of sending it. Never selected
 * in production — an unconfigured production SMS provider must fail loudly, not
 * pretend codes were delivered.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";

  async sendSms(message: OutgoingSms): Promise<SmsSendResult> {
    const ref = message.ref ? ` | challenge ${message.ref.challengeId} ip ${message.ref.ip ?? "?"}` : "";
    console.log(`[ConsoleSmsProvider] To: ${message.to}${ref}\n${message.body}`);
    return { accepted: true };
  }
}
