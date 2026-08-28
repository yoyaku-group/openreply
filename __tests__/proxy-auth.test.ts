import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

function request(pathname: string, cookie?: string) {
  return new NextRequest(`https://openreply.yoyaku.fr${pathname}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("authentication proxy", () => {
  it("redirects a protected route without a session cookie to login", () => {
    const response = proxy(request("/dashboard"));

    expect(response.headers.get("location")).toBe(
      "https://openreply.yoyaku.fr/login?callbackUrl=%2Fdashboard"
    );
  });

  it.each(SESSION_COOKIE_NAMES)(
    "does not redirect /login when %s is stale or incomplete",
    (cookieName) => {
      const response = proxy(request("/login", `${cookieName}=invalid`));

      expect(response.headers.get("location")).toBeNull();
    }
  );

  it.each(SESSION_COOKIE_NAMES)(
    "lets the authenticated page validate %s instead of redirecting at the proxy",
    (cookieName) => {
      const response = proxy(request("/dashboard", `${cookieName}=invalid`));

      expect(response.headers.get("location")).toBeNull();
    }
  );
});
