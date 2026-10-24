import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import express, { type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { getIdentity, googleAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";

describe("googleAuth", () => {
  let server: Server;
  let baseUrl: string;

  const stubGoogle = (
    certs: () => Promise<unknown>,
    verify: () => Promise<unknown>,
  ) => {
    mock.method(OAuth2Client.prototype, "getFederatedSignonCertsAsync", certs);
    mock.method(OAuth2Client.prototype, "verifyIdToken", verify);
  };
  const ticket = (payload: object) =>
    Promise.resolve({ getPayload: () => payload });
  const login = (authorization?: string) =>
    fetch(
      `${baseUrl}/whoami`,
      authorization ? { headers: { authorization } } : {},
    ).then(async (res) => ({ status: res.status, body: await res.json() }));

  beforeEach(async () => {
    const app = express();
    app.get(
      "/whoami",
      googleAuth("client-id"),
      (_req: Request, res: Response) => {
        res.json(getIdentity(res));
      },
    );
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    mock.restoreAll();
    server.closeAllConnections();
    server.close();
  });

  test("a valid token with a verified email identifies the caller by sub", async () => {
    stubGoogle(
      () => Promise.resolve({}),
      () =>
        ticket({
          sub: "123",
          email: "a@example.com",
          email_verified: true,
          name: "A B",
        }),
    );
    assert.deepEqual(await login("Bearer token"), {
      status: 200,
      body: { sub: "123", email: "a@example.com", name: "A B" },
    });
  });

  test("missing, invalid and unverified-email tokens are 401s", async () => {
    stubGoogle(
      () => Promise.resolve({}),
      () => Promise.reject(new Error("Token used too late")),
    );
    assert.equal((await login()).status, 401);
    assert.equal((await login("Basic abc")).status, 401);
    assert.equal((await login("Bearer expired")).status, 401);

    stubGoogle(
      () => Promise.resolve({}),
      () =>
        ticket({ sub: "123", email: "a@example.com", email_verified: false }),
    );
    assert.equal((await login("Bearer token")).status, 401);
  });

  test("not being able to reach Google is a 503, so the FE doesn't send the user back to log in", async () => {
    stubGoogle(
      () =>
        Promise.reject(new Error("getaddrinfo ENOTFOUND www.googleapis.com")),
      () => assert.fail("shouldn't verify without certs"),
    );
    const { status } = await login("Bearer token");
    assert.equal(status, 503);
  });
});
