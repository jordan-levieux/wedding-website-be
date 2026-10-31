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
      accommodation: null,
      guests: [
        {
          guestId: 1,
          name: "Alice",
          surname: "Smith",
          rsvp: null,
          ownAccommodation: null,
        },
        {
          guestId: 2,
          name: "Bob",
          surname: "Smith",
          rsvp: null,
          ownAccommodation: null,
        },
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

  test("RSVPs come back with real booleans", () => {
    signUpAlice();
    db.exec(`
      INSERT INTO rsvps (guest_id, attending, dietary, shuttle, responded_by, responded_at) VALUES
        (1, 1, 'vegetarian', 0, 1, '2026-10-24T10:00:00.000Z'),
        (2, 0, NULL, NULL, 1, '2026-10-24T10:00:00.000Z');
    `);

    const [alice, bob] = store.getGroup("sub-alice")?.guests ?? [];

    assert.deepEqual(alice?.rsvp, {
      attending: true,
      dietary: "vegetarian",
      dietaryOtherDetails: null,
      shuttle: false,
      respondedBy: 1,
      respondedAt: "2026-10-24T10:00:00.000Z",
    });
    assert.equal(bob?.rsvp?.attending, false);
  });

  test("the group's place applies to everyone, and a guest can have their own", () => {
    signUpAlice();
    store.setGroupAccommodation("sub-alice", { lat: -33.95, lng: 22.46 });
    store.setOwnAccommodation("sub-alice", 2, { lat: -33.99, lng: 22.58 });

    const group = store.getGroup("sub-alice");
    assert.deepEqual(group?.accommodation, { lat: -33.95, lng: 22.46 });
    assert.deepEqual(
      group?.guests.map((guest) => guest.ownAccommodation),
      [null, { lat: -33.99, lng: 22.58 }],
    );

    store.setOwnAccommodation("sub-alice", 2, null);
    store.setGroupAccommodation("sub-alice", null);
    const cleared = store.getGroup("sub-alice");
    assert.equal(cleared?.accommodation, null);
    assert.equal(cleared?.guests[1]?.ownAccommodation, null);
  });

  test("a guest's own place can only be set from within their group", () => {
    signUpAlice();
    assert.throws(
      () => store.setOwnAccommodation("sub-alice", 3, { lat: 0, lng: 0 }),
      /only say where guests in your group are staying/,
    );
    assert.throws(
      () => store.setGroupAccommodation("sub-nobody", { lat: 0, lng: 0 }),
      /not registered/,
    );
  });
});
