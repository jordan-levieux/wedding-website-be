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
      INSERT INTO groups (group_id, name) VALUES (1, 'The Smiths'), (2, 'The Joneses');
      INSERT INTO guests (guest_id, group_id, name, surname, plus_one_of, sign_up_uuid) VALUES
        (1, 1, 'Alice', 'Smith', NULL, 'invite-alice'),
        (2, 1, 'Bob', 'Smith', NULL, 'invite-bob'),
        (3, 1, NULL, NULL, 1, NULL),
        (4, 2, 'Carol', 'Jones', NULL, 'invite-carol');
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

  test("the group only contains the caller's own group, plus-ones after their guest", () => {
    signUpAlice();
    const group = store.getGroup("sub-alice");

    assert.equal(group?.selfId, 1);
    assert.equal(group?.groupName, "The Smiths");
    assert.deepEqual(
      group?.guests.map(({ guestId, name, plusOneOf, rsvp }) => ({ guestId, name, plusOneOf, rsvp })),
      [
        { guestId: 1, name: "Alice", plusOneOf: null, rsvp: null },
        { guestId: 3, name: null, plusOneOf: 1, rsvp: null },
        { guestId: 2, name: "Bob", plusOneOf: null, rsvp: null },
      ],
    );
  });

  test("RSVPs come back with real booleans", () => {
    signUpAlice();
    db.exec(`
      INSERT INTO rsvps (guest_id, attending, dietary, shuttle, accommodation, plus_one_name, responded_by, responded_at)
      VALUES (3, 1, 'vegetarian', 0, NULL, 'Dave', 1, '2026-10-24T10:00:00.000Z');
    `);

    const plusOne = store.getGroup("sub-alice")?.guests.find((guest) => guest.guestId === 3);

    assert.deepEqual(plusOne?.rsvp, {
      attending: true,
      dietary: "vegetarian",
      dietaryOtherDetails: null,
      shuttle: false,
      accommodation: null,
      plusOneName: "Dave",
      plusOneSurname: null,
      respondedBy: 1,
      respondedAt: "2026-10-24T10:00:00.000Z",
    });
  });
});
