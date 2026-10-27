import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  extractLinks,
  normalizeEmailBody,
} from "../src/mail/parser";

describe("normalizeEmailBody", () => {
  it("strips HTML chrome, tracking pixels, quotes, and signatures", () => {
    const result = normalizeEmailBody({
      from: "alice@example.com",
      subject: "Lunch",
      bodyHtml: `
        <html><head><style>.x{}</style></head>
        <body>
          <p>Hey <b>Sam</b>,</p>
          <p>Can we meet at <a href="https://example.com/map">3pm</a>?</p>
          <img src="https://tracker.example/pixel.gif" width="1">
          <div class="gmail_quote">On Monday someone wrote:
            <blockquote><p>Earlier message text</p></blockquote>
          </div>
          <div class="gmail_signature">Sent from my phone</div>
        </body></html>`,
    });
    expect(result.usedHtml).toBe(true);
    expect(result.text).toContain("Hey Sam");
    expect(result.text).toContain("3pm");
    expect(result.text).not.toContain("Earlier message");
    expect(result.text).not.toContain("tracker.example");
    expect(result.text).not.toContain("gmail_signature");
    expect(result.links).toContain("https://example.com/map");
  });

  it("keeps the new reply and drops a plain-text quoted chain", () => {
    const result = normalizeEmailBody({
      from: "alice@example.com",
      subject: "Re: Lunch",
      bodyText: [
        "Sounds good — see you at 3.",
        "",
        "On Mon, Oct 20, 2026 at 9:00 AM Bob <bob@example.com> wrote:",
        "> Are we still on?",
        "> Yes",
      ].join("\n"),
    });
    expect(result.text).toBe("Sounds good — see you at 3.");
    expect(result.quotedText).toContain("Are we still on?");
  });

  it("drops a standard signature block", () => {
    const result = normalizeEmailBody({
      from: "alice@example.com",
      bodyText: "Short answer: yes.\n\n-- \nAlice\n+1 555 0100",
    });
    expect(result.text).toBe("Short answer: yes.");
  });

  it("falls back to HTML when the text part is empty", () => {
    const result = normalizeEmailBody({
      from: "alice@example.com",
      bodyText: "   ",
      bodyHtml: "<p>Only HTML here, with enough content to count.</p>",
    });
    expect(result.usedHtml).toBe(true);
    expect(result.text).toContain("Only HTML here");
  });

  it("prefers the text part when both exist", () => {
    const result = normalizeEmailBody({
      bodyText: "Plain text body that is long enough to be meaningful.",
      bodyHtml: "<p>HTML version that is long enough to be meaningful too.</p>",
    });
    expect(result.usedHtml).toBe(false);
    expect(result.text).toContain("Plain text body");
  });

  it("detects bounces from sender, subject, or body", () => {
    expect(
      normalizeEmailBody({ from: "MAILER-DAEMON@example.com", subject: "hi" }).isBounce,
    ).toBe(true);
    expect(
      normalizeEmailBody({ from: "a@example.com", subject: "Undeliverable: hello" }).isBounce,
    ).toBe(true);
    expect(
      normalizeEmailBody({
        from: "a@example.com",
        subject: "Delivery Status Notification (Failure)",
      }).isBounce,
    ).toBe(true);
    expect(normalizeEmailBody({ from: "a@example.com", subject: "hi" }).isBounce).toBe(false);
  });

  it("caps the stored body and builds a short preview", () => {
    const result = normalizeEmailBody(
      { bodyText: "word ".repeat(400) },
      { maxChars: 100 },
    );
    expect(result.text.length).toBe(100);
    expect(result.preview.length).toBeLessThanOrEqual(200);
  });

  it("decodes entities and collapses whitespace", () => {
    const result = normalizeEmailBody({
      bodyHtml: "<p>Tom &amp; Jerry&nbsp;&mdash; 50&nbsp;% off</p><p>See you.</p>",
    });
    expect(result.text).toContain("Tom & Jerry — 50 % off");
    expect(result.text).not.toContain("<p>");
  });

  it("removes mail-client signatures that run to the end", () => {
    const result = normalizeEmailBody({
      bodyText: "See attached.\n\nSent from my iPhone",
    });
    expect(result.text).toBe("See attached.");
  });
});

describe("extractLinks", () => {
  it("dedupes URLs and strips trailing punctuation", () => {
    expect(
      extractLinks("See https://a.example/x. Also https://a.example/x and https://b.example/y)"),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("&amp;&#65;&#x42;&nbsp;")).toBe("&AB ");
  });
});
