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
  test("switches a legacy WAL database to a synced rollback journal and migrates it", () => {
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
    const legacyTable = db
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'users'")
      .get();
    assert.equal(legacyTable, undefined);
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

describe("rsvp audit trail", () => {
  let db: Database.Database;
  // the same upsert shape the RSVP endpoint will use
  const answer = (guestId: number, attending: 0 | 1, respondedBy: number) =>
    db
      .prepare(
        `
          INSERT INTO rsvps (guest_id, attending, responded_by, responded_at)
          VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ'))
          ON CONFLICT (guest_id) DO UPDATE SET
            attending = excluded.attending,
            responded_by = excluded.responded_by,
            responded_at = excluded.responded_at;
        `,
      )
      .run(guestId, attending, respondedBy);

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.exec(`
      INSERT INTO groups (group_id, name) VALUES (1, 'The Smiths');
      INSERT INTO guests (guest_id, group_id, name, surname) VALUES
        (1, 1, 'Alice', 'Smith'),
        (2, 1, 'Bob', 'Smith');
    `);
  });

  test("records every insert and update, including re-submits of the same answer", () => {
    answer(2, 1, 2);
    answer(2, 1, 2);
    answer(2, 0, 1);

    const history = db
      .prepare("SELECT guest_id, attending, responded_by FROM rsvp_history ORDER BY history_id")
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
        changed_fields: "attending",
        was_attending: 1,
        now_attending: 0,
      },
    ]);
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
