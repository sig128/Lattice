import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, clientIp } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit inside the window and reports a retry delay", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 1_000).allowed).toBe(true);
    expect(limiter.check("a", 2_000)).toEqual({ allowed: false, retryAfterSeconds: 8 });
    expect(limiter.check("b", 2_000).allowed).toBe(true);
    expect(limiter.check("a", 10_001).allowed).toBe(true);
  });

  it("returns a slot on release so failed requests do not count", () => {
    const limiter = new SlidingWindowLimiter(1, 10_000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    limiter.release("a");
    expect(limiter.check("a", 1).allowed).toBe(true);
  });

  it("bounds the number of tracked keys", () => {
    const limiter = new SlidingWindowLimiter(1, 10_000, 2);
    limiter.check("a", 0);
    limiter.check("b", 0);
    limiter.check("c", 0);
    expect(limiter.check("a", 1).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("uses the first forwarded address", () => {
    const request = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.7, 127.0.0.1" } });
    expect(clientIp(request)).toBe("203.0.113.7");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });
});
