import { describe, it, expect, vi, beforeEach } from "vitest";

// Set required env vars before any imports
process.env.WEBPAY_COMMERCE_CODE = "597055555532";
process.env.WEBPAY_API_SECRET = "test-secret-min-32-characters-long";
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
process.env.CRON_SECRET = "a".repeat(32);
process.env.BETTER_AUTH_SECRET = "a".repeat(32);

// Mock prisma
const mockQueryRaw = vi.fn();
vi.mock("@/shared/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
}));

describe("/api/health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  it("returns 200 when all checks pass", async () => {
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.checks.database).toBe(true);
    expect(data.checks.transbank_credentials).toBe(true);
  });

  it("returns 503 when database check fails", async () => {
    mockQueryRaw.mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.status).toBe("degraded");
    expect(data.checks.database).toBe(false);
    expect(data.details.database).toBeDefined();
  });

  it("includes timestamp and version in response", async () => {
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const { GET } = await import("./route");
    const response = await GET();

    const data = await response.json();
    expect(data.timestamp).toBeDefined();
    expect(data.version).toBe("0.1.0");
  });
});
