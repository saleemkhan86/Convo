import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGifBytes, searchGifs } from "../src/services/giphy";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  } as unknown as Response;
}

describe("searchGifs", () => {
  it("disables the picker when no API key is configured (and makes no request)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchGifs(undefined, { limit: 12 })).toEqual({ enabled: false, items: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Giphy renditions down to our compact item shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: "abc123",
              title: "  Thumbs up  ",
              images: {
                fixed_width: { url: "https://gif.test/f_w.gif", width: 480, height: 270 },
                fixed_width_small: { url: "https://gif.test/preview.gif" },
              },
            },
            { id: "no-urls" },
          ],
        }),
      ),
    );
    const result = await searchGifs("server-side-key", { q: "thumbs", limit: 5 });
    expect(result.enabled).toBe(true);
    expect(result.items).toEqual([
      {
        id: "abc123",
        title: "Thumbs up",
        previewUrl: "https://gif.test/preview.gif",
        width: 480,
        height: 270,
      },
    ]);
  });

  it("keeps the API key server-side: it goes in the upstream URL, never in items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await searchGifs("secret-key", { limit: 12 });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("api_key=secret-key");
    expect(calledUrl).toContain("giphy.com/v1/gifs/trending");
  });

  it("surfaces upstream failures as a client-safe error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false } as unknown as Response),
    );
    await expect(searchGifs("key", { q: "x", limit: 5 })).rejects.toThrow();
  });
});

function gifResponse(bytes: number, contentType = "image/gif") {
  return {
    ok: true,
    headers: { get: (name: string) => (name === "content-type" ? contentType : null) },
    arrayBuffer: async () => new Uint8Array(bytes),
  } as unknown as Response;
}

describe("fetchGifBytes", () => {
  it("rejects ids that are not Giphy-safe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["", "../etc/passwd", "a".repeat(41), "id with spaces"]) {
      await expect(fetchGifBytes(bad)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads a small GIF into a buffer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gifResponse(1024)));
    const { buffer, mimeType } = await fetchGifBytes("abc123");
    expect(buffer.byteLength).toBe(1024);
    expect(mimeType).toBe("image/gif");
  });

  it("refuses responses that are not really GIFs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gifResponse(16, "text/html")));
    await expect(fetchGifBytes("abc123")).rejects.toThrow();
  });

  it("refuses oversized GIFs, declared or actual", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (n: string) => (n === "content-length" ? String(20 * 1024 * 1024) : "image/gif") },
        arrayBuffer: async () => new Uint8Array(0),
      } as unknown as Response),
    );
    await expect(fetchGifBytes("abc123")).rejects.toThrow();
  });

  it("refuses empty downloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gifResponse(0)));
    await expect(fetchGifBytes("abc123")).rejects.toThrow();
  });
});
