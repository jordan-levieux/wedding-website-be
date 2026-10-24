import Database from "better-sqlite3";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createAdminStore } from "./admin-store.js";
import { createApp } from "./app.js";
import type { Identity } from "./auth.js";
import { migrate } from "./db.js";
import { ExpectedError } from "./error-handler.js";
import { createGuestStore } from "./guest-store.js";

// stands in for Google: the bearer token is the caller's `sub`
const fakeAuth = (req: Request, res: Response, next: NextFunction) => {
  const sub = req.headers.authorization?.replace("Bearer ", "");
  if (!sub) {
    return next(new ExpectedError("no credentials present", 401));
  }
  const identity: Identity = { sub, email: `${sub}@example.com`, name: null };
  res.locals.identity = identity;
  next();
};

const attending = (guestId: number) => ({
  guestId,
  attending: true,
  dietary: "none",
  shuttle: false,
});

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

describe("API", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  const start = (rsvpDeadline = FUTURE) => {
    const app = createApp({
      db,
      store: createGuestStore(db),
      adminStore: createAdminStore(db),
      authenticate: fakeAuth,
      corsUrls: ["http://localhost:4200"],
      rsvpDeadline,
    });
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  };

  const call = async (
    method: string,
    path: string,
    sub: string | null,
    body?: unknown,
  ) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(sub ? { authorization: `Bearer ${sub}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const historyCount = (table: string) =>
    (
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    // Alice (admin) and Bob in group 1, Carol (viewer) and Dave in group 2, Erin hasn't signed up
    db.exec(`
      INSERT INTO guests (guest_id, group_id, name, surname, sign_up_uuid, google_sub) VALUES
        (1, 1, 'Alice', 'Smith', 'invite-alice', 'alice'),
        (2, 1, 'Bob', 'Smith', 'invite-bob', 'bob'),
        (3, 2, 'Carol', 'Jones', 'invite-carol', 'carol'),
        (4, 2, 'Dave', 'Jones', 'invite-dave', 'dave'),
        (5, 3, 'Erin', 'Brown', 'invite-erin', NULL);
      INSERT INTO guest_roles (guest_id, role) VALUES
        (1, 'admin'),
        (3, 'viewer');
    `);
    await start();
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
    db.close();
  });

  describe("login", () => {
    test("returns the caller's group, roles and the RSVP deadline", async () => {
      const { status, body } = await call("POST", "/auth/login", "carol");
      assert.equal(status, 200);
      assert.equal(body.selfId, 3);
      assert.deepEqual(body.roles, ["viewer"]);
      assert.deepEqual(
        body.guests.map((guest: { name: string }) => guest.name),
        ["Carol", "Dave"],
      );
      assert.equal(body.rsvpDeadline, FUTURE.toISOString());
    });

    test("signs up with an unused invite, recording the guest as the updater", async () => {
      const { status, body } = await call(
        "POST",
        "/auth/login?signupId=invite-erin",
        "erin",
      );
      assert.equal(status, 200);
      assert.equal(body.selfId, 5);
      const updatedBy = db
        .prepare("SELECT updated_by FROM guests WHERE guest_id = 5")
        .pluck()
        .get();
      assert.equal(updatedBy, 5);
    });

    test("rejects unregistered accounts and used invites", async () => {
      assert.equal((await call("POST", "/auth/login", "mallory")).status, 403);
      assert.equal(
        (await call("POST", "/auth/login?signupId=invite-alice", "mallory"))
          .status,
        400,
      );
      assert.equal((await call("POST", "/auth/login", null)).status, 401);
    });
  });

  describe("GET /group", () => {
    test("returns the same group as login, without signing anyone up", async () => {
      const login = await call("POST", "/auth/login", "carol");
      const group = await call("GET", "/group", "carol");
      assert.equal(group.status, 200);
      assert.deepEqual(group.body, login.body);
      assert.equal(
        (await call("GET", "/group?signupId=invite-erin", "erin")).status,
        403,
      );
    });
  });

  describe("PUT /rsvp", () => {
    test("RSVPs for yourself and your group, recorded as answered by you", async () => {
      const { status, body } = await call("PUT", "/rsvp", "bob", {
        rsvps: [
          {
            guestId: 2,
            attending: true,
            dietary: "other",
            dietaryOtherDetails: "  no mushrooms ",
            shuttle: true,
            accommodation: { lat: -33.9249, lng: 18.4241 },
          },
          {
            guestId: 1,
            attending: false,
            dietary: "vegetarian",
            shuttle: true,
          },
        ],
      });
      assert.equal(status, 200);
      const [alice, bob] = body.guests;
      assert.deepEqual(
        { ...bob.rsvp, respondedAt: undefined },
        {
          attending: true,
          dietary: "other",
          dietaryOtherDetails: "no mushrooms",
          shuttle: true,
          accommodation: { lat: -33.9249, lng: 18.4241 },
          respondedBy: 2,
          respondedAt: undefined,
        },
      );
      // not attending clears the rest of the answer
      assert.deepEqual(
        { ...alice.rsvp, respondedAt: undefined },
        {
          attending: false,
          dietary: null,
          dietaryOtherDetails: null,
          shuttle: null,
          accommodation: null,
          respondedBy: 2,
          respondedAt: undefined,
        },
      );
      assert.equal(historyCount("rsvp_history"), 2);
    });

    test("anyone outside your group rolls back the whole batch", async () => {
      const { status } = await call("PUT", "/rsvp", "bob", {
        rsvps: [attending(2), { guestId: 3, attending: false }],
      });
      assert.equal(status, 403);
      assert.equal(historyCount("rsvps"), 0);
      assert.equal(historyCount("rsvp_history"), 0);
    });

    test("is closed after the deadline", async () => {
      server.close();
      await start(PAST);
      const { status, body } = await call("PUT", "/rsvp", "bob", {
        rsvps: [attending(2)],
      });
      assert.equal(status, 403);
      assert.match(body.error, /deadline/);
    });

    test("rejects invalid answers", async () => {
      const invalidBodies = [
        {},
        { rsvps: [] },
        { rsvps: [{ guestId: 2 }] },
        { rsvps: [{ ...attending(2), guestId: "2" }] },
        { rsvps: [{ ...attending(2), dietary: undefined }] },
        { rsvps: [{ ...attending(2), dietary: "carnivore" }] },
        { rsvps: [{ ...attending(2), dietary: "other" }] },
        { rsvps: [{ ...attending(2), shuttle: "yes" }] },
        { rsvps: [{ ...attending(2), accommodation: { lat: 91, lng: 0 } }] },
        { rsvps: [{ ...attending(2), accommodation: { lat: 0 } }] },
        { rsvps: [attending(2), { guestId: 2, attending: false }] },
      ];
      for (const body of invalidBodies) {
        assert.equal(
          (await call("PUT", "/rsvp", "bob", body)).status,
          400,
          JSON.stringify(body),
        );
      }
      assert.equal(historyCount("rsvps"), 0);
    });

    test("shuttle is optional when attending", async () => {
      const { status, body } = await call("PUT", "/rsvp", "bob", {
        rsvps: [{ guestId: 2, attending: true, dietary: "none" }],
      });
      assert.equal(status, 200);
      assert.equal(body.guests[1].rsvp.shuttle, null);
    });

    test("malformed and oversized bodies are client errors, not 500s", async () => {
      const malformed = await fetch(`${baseUrl}/rsvp`, {
        method: "PUT",
        headers: {
          authorization: "Bearer bob",
          "content-type": "application/json",
        },
        body: "{not json",
      });
      assert.equal(malformed.status, 400);
      const oversized = await call("PUT", "/rsvp", "bob", {
        rsvps: [attending(2)],
        padding: "x".repeat(200_000),
      });
      assert.equal(oversized.status, 413);
    });
  });

  describe("admin read endpoints", () => {
    test("are open to viewers and admins only", async () => {
      for (const path of [
        "/admin/guests",
        "/admin/rsvp-changes",
        "/admin/guests/2/history",
      ]) {
        assert.equal((await call("GET", path, "carol")).status, 200, path);
        assert.equal((await call("GET", path, "alice")).status, 200, path);
        assert.equal((await call("GET", path, "bob")).status, 403, path);
        assert.equal((await call("GET", path, null)).status, 401, path);
      }
    });

    test("list every guest with their invite, roles and RSVP", async () => {
      const { body } = await call("GET", "/admin/guests", "alice");
      assert.equal(body.length, 5);
      assert.deepEqual(body[0], {
        guestId: 1,
        groupId: 1,
        name: "Alice",
        surname: "Smith",
        email: null,
        tokenName: null,
        signUpUuid: "invite-alice",
        signedUpAt: null,
        updatedBy: null,
        roles: ["admin"],
        rsvp: null,
      });
    });

    test("hide invites from viewers, since an invite lets whoever has it claim a guest", async () => {
      const { body: guests } = await call("GET", "/admin/guests", "carol");
      assert.ok(
        guests.every(
          (guest: { signUpUuid: string | null }) => guest.signUpUuid === null,
        ),
      );
      const { body: history } = await call(
        "GET",
        "/admin/guests/1/history",
        "carol",
      );
      assert.equal(history.details[0].signUpUuid, null);
      const { body: adminHistory } = await call(
        "GET",
        "/admin/guests/1/history",
        "alice",
      );
      assert.equal(adminHistory.details[0].signUpUuid, "invite-alice");
    });

    test("an unknown guest's history is a 404", async () => {
      assert.equal(
        (await call("GET", "/admin/guests/99/history", "alice")).status,
        404,
      );
    });
  });

  describe("admin write endpoints", () => {
    test("are closed to viewers", async () => {
      assert.equal(
        (await call("PUT", "/admin/rsvps", "carol", { rsvps: [attending(4)] }))
          .status,
        403,
      );
      assert.equal(
        (
          await call("POST", "/admin/guests", "carol", {
            name: "X",
            surname: "Y",
          })
        ).status,
        403,
      );
      assert.equal(
        (await call("PATCH", "/admin/guests/4", "carol", { name: "X" })).status,
        403,
      );
    });

    test("admins can RSVP for anyone, even after the deadline, and it shows up as a change", async () => {
      await call("PUT", "/rsvp", "dave", { rsvps: [attending(4)] });
      server.close();
      await start(PAST);

      const { status } = await call("PUT", "/admin/rsvps", "alice", {
        rsvps: [{ guestId: 4, attending: false }],
      });
      assert.equal(status, 200);

      const { body: changes } = await call(
        "GET",
        "/admin/rsvp-changes",
        "carol",
      );
      assert.equal(changes.length, 1);
      assert.equal(changes[0].guest, "Dave Jones");
      assert.equal(changes[0].previousAnswerBy, "Dave Jones");
      assert.equal(changes[0].changedBy, "Alice Smith");
      assert.equal(changes[0].wasAttending, true);
      assert.equal(changes[0].nowAttending, false);
    });

    test("an unknown guest rolls back an admin RSVP batch", async () => {
      const { status } = await call("PUT", "/admin/rsvps", "alice", {
        rsvps: [attending(4), attending(99)],
      });
      assert.equal(status, 404);
      assert.equal(historyCount("rsvps"), 0);
    });

    test("creates a guest with a fresh invite, in a new group unless one is given", async () => {
      const { status, body } = await call("POST", "/admin/guests", "alice", {
        name: "Frank",
        surname: "Green",
        roles: ["venue_accommodation"],
      });
      assert.equal(status, 201);
      assert.equal(body.groupId, 4);
      assert.match(body.signUpUuid, /^[0-9a-f-]{36}$/);
      assert.deepEqual(body.roles, ["venue_accommodation"]);
      assert.equal(body.updatedBy, 1);

      const { body: joined } = await call("POST", "/admin/guests", "alice", {
        groupId: 2,
        name: "Gina",
        surname: "Jones",
      });
      assert.equal(joined.groupId, 2);
    });

    test("edits are audited in the guest's history", async () => {
      const { status, body } = await call("PATCH", "/admin/guests/4", "alice", {
        name: "David",
        roles: ["viewer", "venue_accommodation"],
        regenerateInvite: true,
        unlinkGoogleAccount: true,
      });
      assert.equal(status, 200);
      assert.equal(body.name, "David");
      assert.notEqual(body.signUpUuid, "invite-dave");
      assert.deepEqual(body.roles, ["venue_accommodation", "viewer"]);
      // unlinked, so Dave can't log in until he uses the new invite
      assert.equal((await call("POST", "/auth/login", "dave")).status, 403);

      await call("PATCH", "/admin/guests/4", "alice", {
        roles: ["venue_accommodation"],
      });

      const { body: history } = await call(
        "GET",
        "/admin/guests/4/history",
        "carol",
      );
      assert.deepEqual(
        history.details.map(
          (row: { name: string; updatedBy: number | null }) => [
            row.name,
            row.updatedBy,
          ],
        ),
        [
          ["Dave", null],
          ["David", 1],
        ],
      );
      assert.deepEqual(
        history.roles.map(
          (row: {
            role: string;
            grantedBy: number;
            revokedBy: number | null;
          }) => [row.role, row.grantedBy, row.revokedBy],
        ),
        [
          ["viewer", 1, 1],
          ["venue_accommodation", 1, null],
        ],
      );
    });

    test("admins can't remove their own admin role", async () => {
      const { status } = await call("PATCH", "/admin/guests/1", "alice", {
        roles: [],
      });
      assert.equal(status, 400);
      assert.deepEqual(
        (await call("POST", "/auth/login", "alice")).body.roles,
        ["admin"],
      );
    });

    test("rejects invalid guest edits", async () => {
      assert.equal(
        (await call("PATCH", "/admin/guests/4", "alice", {})).status,
        400,
      );
      assert.equal(
        (await call("PATCH", "/admin/guests/4", "alice", { name: " " })).status,
        400,
      );
      assert.equal(
        (await call("PATCH", "/admin/guests/4", "alice", { roles: ["owner"] }))
          .status,
        400,
      );
      assert.equal(
        (await call("PATCH", "/admin/guests/abc", "alice", { name: "X" }))
          .status,
        400,
      );
      assert.equal(
        (await call("PATCH", "/admin/guests/99", "alice", { name: "X" }))
          .status,
        404,
      );
      assert.equal(
        (await call("POST", "/admin/guests", "alice", { name: "X" })).status,
        400,
      );
    });
  });
});
