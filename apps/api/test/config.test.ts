import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/convo",
  JWT_SECRET: "x".repeat(48),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(4000);
    expect(config.OTP_TTL_SECONDS).toBe(600);
    expect(config.OTP_MAX_ATTEMPTS).toBe(5);
    expect(config.DEV_EXPOSE_OTP).toBe(false);
    expect(config.EXTERNAL_EMAIL_DAILY_LIMIT).toBe(50);
  });

  it("rejects a weak JWT secret", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("rejects missing DATABASE_URL", () => {
    expect(() => loadConfig({ JWT_SECRET: "x".repeat(48) })).toThrow(/DATABASE_URL/);
  });

  it("refuses DEV_EXPOSE_OTP in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", DEV_EXPOSE_OTP: "true" }),
    ).toThrow(/DEV_EXPOSE_OTP/);
  });

  it("allows DEV_EXPOSE_OTP in development", () => {
    const config = loadConfig({ ...base, DEV_EXPOSE_OTP: "true" });
    expect(config.DEV_EXPOSE_OTP).toBe(true);
  });

  it("defaults API_PUBLIC_URL to the local API port in development", () => {
    expect(loadConfig(base).API_PUBLIC_URL).toBe("http://localhost:4000");
    expect(loadConfig({ ...base, PORT: "4100" }).API_PUBLIC_URL).toBe("http://localhost:4100");
  });

  it("requires API_PUBLIC_URL in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/API_PUBLIC_URL/);
  });

  it("trims trailing slashes from API_PUBLIC_URL", () => {
    const config = loadConfig({ ...base, API_PUBLIC_URL: "https://api.example.com/" });
    expect(config.API_PUBLIC_URL).toBe("https://api.example.com");
  });
});
