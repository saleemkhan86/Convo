import { describe, expect, it } from "vitest";
import { firstUrl, isBlockedAddress, parseLinkMetadata } from "../src/services/unfurl";

describe("firstUrl", () => {
  it("returns the first http(s) link in free text", () => {
    expect(firstUrl("check https://example.com/a and http://b.test/x")).toBe("https://example.com/a");
  });

  it("trims trailing sentence punctuation", () => {
    expect(firstUrl("see https://example.com/path,")).toBe("https://example.com/path");
    expect(firstUrl("https://example.com/dir.")).toBe("https://example.com/dir");
  });

  it("returns null when there is nothing to unfurl", () => {
    expect(firstUrl(null)).toBeNull();
    expect(firstUrl(undefined)).toBeNull();
    expect(firstUrl("no links here")).toBeNull();
    expect(firstUrl("ftp://example.com/file")).toBeNull();
  });
});

describe("isBlockedAddress (SSRF guard)", () => {
  it("blocks IPv4 reserved space", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("allows public IPv4 space", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "100.63.0.1", "192.169.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it("blocks IPv6 loopback, link-local, ULA and multicast", () => {
    for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::7", "ff02::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("blocks IPv4-mapped and 6to4 embedded IPv4", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:192.168.10.10")).toBe(true);
    // 2002:7f00:0001:: embeds 127.0.0.1
    expect(isBlockedAddress("2002:7f00:1::")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects garbage instead of guessing", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("parseLinkMetadata", () => {
  const base = "https://example.com/article";

  it("prefers Open Graph fields and absolutizes relative images", () => {
    const html = `
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="The Real Title" />
        <meta property="og:description" content="Summary of the page." />
        <meta property="og:image" content="/img/cover.png" />
        <meta property="og:site_name" content="Example Press" />
      </head><body></body></html>`;
    expect(parseLinkMetadata(html, base)).toEqual({
      url: base,
      title: "The Real Title",
      description: "Summary of the page.",
      image: "https://example.com/img/cover.png",
      siteName: "Example Press",
    });
  });

  it("falls back to twitter tags and the page title", () => {
    const html = `
      <title>Plain Page</title>
      <meta name="twitter:description" content="Tiny summary">
      <meta name="description" content="should lose to twitter">`;
    const preview = parseLinkMetadata(html, base);
    expect(preview.title).toBe("Plain Page");
    expect(preview.description).toBe("Tiny summary");
    expect(preview.image).toBeNull();
  });

  it("decodes entities and ignores non-http image protocols", () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry &#x27;s" /><meta property="og:image" content="javascript:alert(1)">`;
    const preview = parseLinkMetadata(html, base);
    expect(preview.title).toBe("Tom & Jerry 's");
    expect(preview.image).toBeNull();
  });

  it("refuses preview images pointing at internal addresses", () => {
    const html = `<meta property="og:title" content="x" /><meta property="og:image" content="http://169.254.169.254/latest/meta-data" />`;
    expect(parseLinkMetadata(html, base).image).toBeNull();
  });

  it("truncates oversized fields", () => {
    const html = `<meta property="og:title" content="${"a".repeat(300)}" />`;
    const preview = parseLinkMetadata(html, base);
    expect(preview.title).toHaveLength(240);
    expect(preview.title?.endsWith("…")).toBe(true);
  });
});
