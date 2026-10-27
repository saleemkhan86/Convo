import { describe, expect, it } from "vitest";
import { buildMimeMessage } from "../src/mail/providers/google";

function bodyAfterHeaders(raw: string): string {
  const split = raw.indexOf("\r\n\r\n");
  return split === -1 ? "" : raw.slice(split + 4);
}

describe("buildMimeMessage", () => {
  it("writes RFC 5322 headers and a base64 text body", () => {
    const raw = buildMimeMessage(
      {
        from: { address: "alice@example.com", name: "Alice" },
        to: [{ address: "bob@example.com", name: "Bob" }],
        cc: [{ address: "carol@example.com" }],
        subject: "Héllo there",
        text: "Line one\r\nLine two",
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
      },
      "<new@convo.local>",
    );

    expect(raw).toContain("From: Alice <alice@example.com>");
    expect(raw).toContain("To: Bob <bob@example.com>");
    expect(raw).toContain("Cc: carol@example.com");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("Message-ID: <new@convo.local>");
    expect(raw).toContain("In-Reply-To: <parent@example.com>");
    expect(raw).toContain("References: <root@example.com> <parent@example.com>");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");

    const body = bodyAfterHeaders(raw)
      .split("\r\n")
      .filter((line) => !line.startsWith("--") && line.length > 0)
      .join("");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Line one\r\nLine two");
  });

  it("sanitizes header injection attempts", () => {
    const raw = buildMimeMessage(
      {
        from: { address: "alice@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "hello\r\nBcc: victim@example.com",
        text: "body",
      },
      "<id@convo.local>",
    );
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw.split("\r\n").some((line) => line.includes("victim@example.com"))).toBe(true);
  });

  it("builds multipart/alternative plus attachments", () => {
    const raw = buildMimeMessage(
      {
        from: { address: "alice@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Files",
        text: "See attached.",
        html: "<p>See attached.</p>",
        attachments: [
          {
            filename: "notes.txt",
            mimeType: "text/plain",
            content: Buffer.from("hello"),
          },
        ],
      },
      "<id@convo.local>",
    );
    expect(raw).toContain('multipart/mixed; boundary="convo-mixed"');
    expect(raw).toContain('multipart/alternative; boundary="convo-alt"');
    expect(raw).toContain('filename="notes.txt"');
  });
});
