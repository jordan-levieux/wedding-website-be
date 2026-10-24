import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { migrate, openDatabase } from "./db.js";

const tempDir = mkdtempSync(join(tmpdir(), "wedding-db-test-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe("openDatabase", () => {
  test("switches a WAL database to a synced rollback journal and migrates it", () => {
    const filePath = join(tempDir, "legacy.db");
    const legacy = new Database(filePath);
    legacy.pragma("journal_mode = WAL");
    legacy.exec("CREATE TABLE users (user_id INTEGER PRIMARY KEY)");
    legacy.close();

    const db = openDatabase(filePath);

    assert.equal(db.pragma("journal_mode", { simple: true }), "delete");
    assert.equal(db.pragma("synchronous", { simple: true }), 2); // FULL
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    db.close();
  });

  test("leaves an up-to-date database alone", () => {
    const filePath = join(tempDir, "current.db");
    openDatabase(filePath).close();
    const db = openDatabase(filePath);
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    db.close();
  });
});

describe("rsvps", () => {
  let db: Database.Database;
  // the same upsert shape the RSVP endpoint will use
  const answer = (
    guestId: number,
    attending: 0 | 1,
    respondedBy: number,
    accommodation: [number, number] | [null, null] = [null, null],
  ) =>
    db
      .prepare(
        `
          INSERT INTO rsvps (guest_id, attending, dietary, shuttle, accommodation_lat, accommodation_lng, responded_by, responded_at)
          VALUES ($guestId, $attending, iif($attending, 'none', NULL), iif($attending, 0, NULL), $lat, $lng, $respondedBy, strftime('%Y-%m-%dT%H:%M:%fZ'))
          ON CONFLICT (guest_id) DO UPDATE SET
            attending = excluded.attending,
            dietary = excluded.dietary,
            shuttle = excluded.shuttle,
            accommodation_lat = excluded.accommodation_lat,
            accommodation_lng = excluded.accommodation_lng,
            responded_by = excluded.responded_by,
            responded_at = excluded.responded_at;
        `,
      )
      .run({
        guestId,
        attending,
        lat: accommodation[0],
        lng: accommodation[1],
        respondedBy,
      });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.exec(`
      INSERT INTO guests (guest_id, group_id, name, surname) VALUES
        (1, 1, 'Alice', 'Smith'),
        (2, 1, 'Bob', 'Smith');
    `);
  });

  test("accommodation must be a valid lat/lng pair or nothing", () => {
    answer(1, 1, 1, [-33.9249, 18.4241]);
    answer(2, 1, 2);
    assert.throws(
      () => answer(1, 1, 1, [91, 18.4241]),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => answer(1, 1, 1, [-33.9249, 181]),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        db.exec("UPDATE rsvps SET accommodation_lng = NULL WHERE guest_id = 1"),
      /CHECK constraint failed/,
    );
  });

  test("attending guests must give a dietary answer, and details for 'other'", () => {
    const insert = (values: string) =>
      db.exec(
        `INSERT INTO rsvps (guest_id, attending, dietary, dietary_other_details, shuttle, responded_by, responded_at) VALUES ${values}`,
      );
    assert.throws(
      () => insert("(1, 1, NULL, NULL, 0, 1, 'now')"),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert("(1, 1, 'other', NULL, 0, 1, 'now')"),
      /CHECK constraint failed/,
    );
    insert("(1, 1, 'other', 'no nuts', 0, 1, 'now')");
    insert("(2, 0, NULL, NULL, NULL, 2, 'now')");
  });

  test("every insert and update is recorded in rsvp_history, re-submits of the same answer included", () => {
    answer(2, 1, 2);
    answer(2, 1, 2);
    answer(2, 0, 1);

    const history = db
      .prepare(
        "SELECT guest_id, attending, responded_by FROM rsvp_history ORDER BY history_id",
      )
      .all();
    assert.deepEqual(history, [
      { guest_id: 2, attending: 1, responded_by: 2 },
      { guest_id: 2, attending: 1, responded_by: 2 },
      { guest_id: 2, attending: 0, responded_by: 1 },
    ]);
  });

  test("rsvp_changes only lists answers that changed, and who changed them", () => {
    answer(2, 1, 2);
    answer(2, 1, 2);
    answer(2, 0, 1);
    answer(1, 1, 1);
    answer(1, 1, 1, [-33.9249, 18.4241]);

    const changes = db
      .prepare(
        "SELECT guest, previous_answer_by, changed_by, changed_fields, was_attending, now_attending FROM rsvp_changes",
      )
      .all();
    assert.deepEqual(changes, [
      {
        guest: "Bob Smith",
        previous_answer_by: "Bob Smith",
        changed_by: "Alice Smith",
        changed_fields: "attending, dietary, shuttle",
        was_attending: 1,
        now_attending: 0,
      },
      {
        guest: "Alice Smith",
        previous_answer_by: "Alice Smith",
        changed_by: "Alice Smith",
        changed_fields: "accommodation",
        was_attending: 1,
        now_attending: 1,
      },
    ]);
  });

  test("guest edits are recorded in guest_history, which can't be edited or deleted", () => {
    db.exec(
      "UPDATE guests SET name = 'Robert', updated_by = 1 WHERE guest_id = 2",
    );

    const history = db
      .prepare(
        "SELECT name, updated_by FROM guest_history WHERE guest_id = 2 ORDER BY history_id",
      )
      .all();
    assert.deepEqual(history, [
      { name: "Bob", updated_by: null },
      { name: "Robert", updated_by: 1 },
    ]);
    assert.throws(
      () => db.exec("UPDATE guest_history SET name = 'x'"),
      /append-only/,
    );
    assert.throws(() => db.exec("DELETE FROM guest_history"), /append-only/);
  });

  test("roles can be revoked once but never deleted or rewritten", () => {
    db.exec(
      "INSERT INTO guest_roles (guest_id, role, granted_by) VALUES (2, 'viewer', 1)",
    );
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO guest_roles (guest_id, role) VALUES (2, 'viewer')",
        ),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => db.exec("UPDATE guest_roles SET role = 'admin'"),
      /only be revoked/,
    );
    assert.throws(
      () => db.exec("DELETE FROM guest_roles"),
      /revoke roles instead/,
    );

    db.exec(
      "UPDATE guest_roles SET revoked_by = 1, revoked_at = 'now' WHERE guest_id = 2",
    );
    assert.throws(
      () =>
        db.exec(
          "UPDATE guest_roles SET revoked_by = 2, revoked_at = 'later' WHERE guest_id = 2",
        ),
      /only be revoked/,
    );
    // can be granted again after being revoked
    db.exec(
      "INSERT INTO guest_roles (guest_id, role, granted_by) VALUES (2, 'viewer', 1)",
    );
  });

  test("rsvp_history can't be edited or deleted", () => {
    answer(1, 1, 1);
    assert.throws(
      () => db.exec("UPDATE rsvp_history SET attending = 0"),
      /append-only/,
    );
    assert.throws(() => db.exec("DELETE FROM rsvp_history"), /append-only/);
  });
});
