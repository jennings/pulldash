import { test, expect, describe, afterEach } from "bun:test";
import app from "./api";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /api/auth/device/code", () => {
  test("proxies to GitHub and returns the device code response", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("https://github.com/login/device/code");
      return new Response(
        JSON.stringify({ device_code: "abc", user_code: "ABCD-1234", expires_in: 900 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await app.request("/api/auth/device/code", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.device_code).toBe("abc");
    expect(data.user_code).toBe("ABCD-1234");
  });

  test("returns 500 with error details when GitHub returns non-ok", async () => {
    mockFetch(async () => new Response("bad request", { status: 400 }));

    const res = await app.request("/api/auth/device/code", { method: "POST" });
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBeDefined();
  });

  test("returns 500 with error message when fetch throws", async () => {
    mockFetch(async () => { throw new Error("network failure"); });

    const res = await app.request("/api/auth/device/code", { method: "POST" });
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBe("network failure");
  });
});

describe("POST /api/auth/device/token", () => {
  test("returns 400 when device_code is missing", async () => {
    const res = await app.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/device_code/);
  });

  test("proxies token request to GitHub and returns access token", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("https://github.com/login/oauth/access_token");
      return new Response(
        JSON.stringify({ access_token: "gho_abc123", token_type: "bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await app.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: "dev123" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.access_token).toBe("gho_abc123");
  });

  test("returns 500 when GitHub token endpoint returns non-ok", async () => {
    mockFetch(async () => new Response("internal error", { status: 503 }));

    const res = await app.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: "dev123" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBeDefined();
  });

  test("returns 500 with error message when fetch throws", async () => {
    mockFetch(async () => { throw new Error("timeout"); });

    const res = await app.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: "dev123" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBe("timeout");
  });

  test("sends correct grant_type and device_code to GitHub", async () => {
    let capturedBody: any;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await app.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: "mycode" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(capturedBody.device_code).toBe("mycode");
    expect(capturedBody.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(capturedBody.client_id).toBeDefined();
  });
});
