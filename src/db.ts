import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export const openDatabase = (filePath: string): Database.Database => {
  const db = new Database(filePath);
  // The DB file sits on a GCS FUSE mount, which only uploads a file when it is fsynced or closed.
  // WAL mode doesn't fsync on commit (better-sqlite3 builds with WAL synchronous=NORMAL) and relies on
  // shared memory that network filesystems don't provide, so use a rollback journal and fsync every
  // commit: a write has then reached the bucket before we respond.
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
};

// Applies migrations/NNN_*.sql in order, tracking the last applied NNN in PRAGMA user_version.
export const migrate = (db: Database.Database) => {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()
    .forEach((file) => {
      const version = Number.parseInt(file, 10);
      if (version <= currentVersion) {
        return;
      }
      const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
      db.transaction(() => {
        db.exec(sql);
        db.pragma(`user_version = ${version}`);
      })();
      console.log(`applied migration ${file}`);
    });
};
