import { describe, expect, it } from "vitest";
import {
  giphyItemSchema,
  giphyListResultSchema,
  giphyUploadRequestSchema,
  linkPreviewSchema,
  messageLocationSchema,
  sendMessageRequestSchema,
  sharedContactSchema,
  wsServerEventSchema,
} from "../src/chats";
import { accountSchema, mediaAutoDownloadSchema } from "../src/identity";
import { updateProfileRequestSchema } from "../src/auth";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("sendMessageRequestSchema (location / contact / sticker)", () => {
  it("accepts a location-only share", () => {
    const parsed = sendMessageRequestSchema.parse({
      clientMessageId: UUID,
      location: { latitude: 48.8584, longitude: 2.2945, name: "Eiffel Tower" },
    });
    expect(parsed.location).toEqual({ latitude: 48.8584, longitude: 2.2945, name: "Eiffel Tower" });
    expect(parsed.contactCard).toBeUndefined();
    expect(parsed.sticker).toBe(false);
  });

  it("accepts a contact-card-only share", () => {
    const parsed = sendMessageRequestSchema.parse({
      clientMessageId: UUID,
      contactCard: { displayName: "Ada Lovelace", phone: "+15551234567" },
    });
    expect(parsed.contactCard?.displayName).toBe("Ada Lovelace");
  });

  it("refuses a message that shares both a location and a contact", () => {
    expect(
      sendMessageRequestSchema.safeParse({
        clientMessageId: UUID,
        location: { latitude: 1, longitude: 1 },
        contactCard: { displayName: "Someone" },
      }).success,
    ).toBe(false);
  });

  it("still requires *something* to send", () => {
    expect(sendMessageRequestSchema.safeParse({ clientMessageId: UUID }).success).toBe(false);
  });

  it("bounds coordinates like the schema promises", () => {
    expect(messageLocationSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(messageLocationSchema.safeParse({ latitude: 0, longitude: -181 }).success).toBe(false);
    expect(messageLocationSchema.safeParse({ latitude: -90, longitude: 180 }).success).toBe(true);
  });

  it("requires a display name on a shared contact", () => {
    expect(sharedContactSchema.safeParse({ phone: "+15550000000" }).success).toBe(false);
    expect(sharedContactSchema.safeParse({ displayName: "  " }).success).toBe(false);
  });
});

describe("link preview + GIF contracts", () => {
  it("parses the async message.linkPreview socket event", () => {
    const event = wsServerEventSchema.parse({
      type: "message.linkPreview",
      conversationId: "c1",
      messageId: "m1",
      preview: {
        url: "https://example.com/a",
        title: "A",
        description: null,
        image: "https://example.com/a.png",
        siteName: null,
      },
    });
    expect(event.type).toBe("message.linkPreview");
  });

  it("link preview fields are all nullable except the url", () => {
    expect(
      linkPreviewSchema.parse({ url: "https://example.com", title: null, description: null, image: null, siteName: null }),
    ).toMatchObject({ url: "https://example.com" });
  });

  it("giphy items carry exactly what the picker renders", () => {
    expect(
      giphyItemSchema.parse({ id: "abc", title: null, previewUrl: "https://g/preview.gif", width: 200, height: 110 }),
    ).toBeTruthy();
    expect(giphyItemSchema.safeParse({ id: "abc" }).success).toBe(false);
    expect(giphyListResultSchema.parse({ enabled: false, items: [] }).enabled).toBe(false);
  });

  it("upload ids stay Giphy-safe", () => {
    expect(giphyUploadRequestSchema.safeParse({ giphyId: "" }).success).toBe(false);
    expect(giphyUploadRequestSchema.safeParse({ giphyId: "x".repeat(41) }).success).toBe(false);
    expect(giphyUploadRequestSchema.parse({ giphyId: "26uaZWnM2kJwcKDGba" }).giphyId).toBe("26uaZWnM2kJwcKDGba");
  });
});

describe("media auto-download preference", () => {
  it("only knows ALWAYS and WIFI_ONLY", () => {
    expect(mediaAutoDownloadSchema.parse("WIFI_ONLY")).toBe("WIFI_ONLY");
    expect(mediaAutoDownloadSchema.safeParse("NEVER").success).toBe(false);
  });

  it("updates ride the profile patch", () => {
    expect(updateProfileRequestSchema.parse({}).mediaAutoDownload).toBeUndefined();
    expect(updateProfileRequestSchema.parse({ mediaAutoDownload: "ALWAYS" }).mediaAutoDownload).toBe("ALWAYS");
  });

  it("accounts default to ALWAYS", () => {
    const account = accountSchema.parse({
      id: "u1",
      displayName: null,
      avatarUrl: null,
      bio: null,
      phone: null,
      email: null,
      capabilities: { chats: true, mail: false },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(account.mediaAutoDownload).toBe("ALWAYS");
  });
});
