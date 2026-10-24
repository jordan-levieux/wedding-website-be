import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { migrate } from "./db.js";
import { createGuestStore, type GuestStore } from "./guest-store.js";

describe("guest store", () => {
  let db: Database.Database;
  let store: GuestStore;
  const signUpAlice = () =>
    store.signUp({
      signupUuid: "invite-alice",
      sub: "sub-alice",
      email: "alice@example.com",
      tokenName: "Alice Smith",
    });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.exec(`
      INSERT INTO guests (guest_id, group_id, name, surname, sign_up_uuid) VALUES
        (1, 1, 'Alice', 'Smith', 'invite-alice'),
        (2, 1, 'Bob', 'Smith', 'invite-bob'),
        (3, 2, 'Carol', 'Jones', 'invite-carol');
      INSERT INTO guest_roles (guest_id, role) VALUES
        (2, 'venue_accommodation'),
        (3, 'viewer'),
        (3, 'admin');
    `);
    store = createGuestStore(db);
  });

  test("an account that hasn't signed up has no group", () => {
    assert.equal(store.getGroup("sub-alice"), undefined);
  });

  test("an invite can only be used once", () => {
    assert.equal(signUpAlice(), 1);
    assert.equal(
      store.signUp({
        signupUuid: "invite-alice",
        sub: "sub-mallory",
        email: "mallory@example.com",
        tokenName: null,
      }),
      undefined,
    );
    assert.equal(store.getGroup("sub-mallory"), undefined);
  });

  test("an unknown invite doesn't sign anyone up", () => {
    assert.equal(
      store.signUp({
        signupUuid: "not-an-invite",
        sub: "sub-mallory",
        email: "mallory@example.com",
        tokenName: null,
      }),
      undefined,
    );
  });

  test("the group only contains the caller's own group", () => {
    signUpAlice();
    assert.deepEqual(store.getGroup("sub-alice"), {
      selfId: 1,
      roles: [],
      guests: [
        { guestId: 1, name: "Alice", surname: "Smith", rsvp: null },
        { guestId: 2, name: "Bob", surname: "Smith", rsvp: null },
      ],
    });
  });

  test("only the caller's own roles come back with the group", () => {
    store.signUp({
      signupUuid: "invite-carol",
      sub: "sub-carol",
      email: "carol@example.com",
      tokenName: null,
    });
    assert.deepEqual(store.getGroup("sub-carol")?.roles, ["admin", "viewer"]);
  });

  test("RSVPs come back with real booleans and accommodation as coordinates", () => {
    signUpAlice();
    db.exec(`
      INSERT INTO rsvps (guest_id, attending, dietary, shuttle, accommodation_lat, accommodation_lng, responded_by, responded_at) VALUES
        (1, 1, 'vegetarian', 0, -33.9249, 18.4241, 1, '2026-10-24T10:00:00.000Z'),
        (2, 0, NULL, NULL, NULL, NULL, 1, '2026-10-24T10:00:00.000Z');
    `);

    const [alice, bob] = store.getGroup("sub-alice")?.guests ?? [];

    assert.deepEqual(alice?.rsvp, {
      attending: true,
      dietary: "vegetarian",
      dietaryOtherDetails: null,
      shuttle: false,
      accommodation: { lat: -33.9249, lng: 18.4241 },
      respondedBy: 1,
      respondedAt: "2026-10-24T10:00:00.000Z",
    });
    assert.equal(bob?.rsvp?.attending, false);
    assert.equal(bob?.rsvp?.accommodation, null);
  });
});
