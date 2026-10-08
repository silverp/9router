import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", () => ({ default: {
  mkdirSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(),
} }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("DATA_DIR", "");
  vi.stubEnv("JWT_SECRET", "test-only-session-key");
  vi.stubEnv("INITIAL_PASSWORD", "test-only-password");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vercel runtime", () => {
  it("uses writable scratch storage instead of the runtime home", async () => {
    const { DATA_DIR } = await import("@/lib/dataDir.js");
    expect(DATA_DIR).toBe(path.join(os.tmpdir(), "9router"));
  });
  it("preserves an explicit writable DATA_DIR", async () => {
    vi.stubEnv("DATA_DIR", "/tmp/9router-custom");
    const { DATA_DIR } = await import("@/lib/dataDir.js");
    expect(DATA_DIR).toBe("/tmp/9router-custom");
  });
  it.each(["EROFS", "EACCES", "EPERM", "ENOENT"])("falls back safely on %s", async (code) => {
    const fs = (await import("node:fs")).default;
    fs.mkdirSync.mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
    vi.stubEnv("DATA_DIR", "/unavailable/9router");
    const { DATA_DIR } = await import("@/lib/dataDir.js");
    expect(DATA_DIR).toBe(path.join(os.tmpdir(), "9router"));
  });
  it("rejects an instance-local session secret on Vercel", async () => {
    vi.stubEnv("JWT_SECRET", "");
    await expect(import("@/lib/auth/dashboardSession.js")).rejects.toThrow("JWT_SECRET must be configured");
  });
  it("rejects the public default password on Vercel", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "");
    await expect(import("@/lib/auth/dashboardSession.js")).rejects.toThrow("INITIAL_PASSWORD must be configured");
  });
  it("verifies a session in a separate module instance without filesystem secrets", async () => {
    const first = await import("@/lib/auth/dashboardSession.js");
    const token = await first.createDashboardAuthToken();
    vi.resetModules();
    const second = await import("@/lib/auth/dashboardSession.js");
    expect(await second.verifyDashboardAuthToken(token)).toBe(true);
    const fs = (await import("node:fs")).default;
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
  it("preserves the desktop default outside Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    const { DATA_DIR } = await import("@/lib/dataDir.js");
    expect(DATA_DIR).toBe(path.join(os.homedir(), ".9router"));
  });
});
