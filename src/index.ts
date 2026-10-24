import config from "config";
import { createAdminStore } from "./admin-store.js";
import { createApp } from "./app.js";
import { googleAuth } from "./auth.js";
import { openDatabase } from "./db.js";
import { createGuestStore } from "./guest-store.js";

const port: number = config.get("server.port");
const rsvpDeadline = new Date(config.get<string>("rsvp.deadline"));
if (Number.isNaN(rsvpDeadline.getTime())) {
  throw new Error("rsvp.deadline must be an ISO 8601 date-time");
}
const db = openDatabase(config.get("db.sqliteFilePath"));

const app = createApp({
  db,
  store: createGuestStore(db),
  adminStore: createAdminStore(db),
  authenticate: googleAuth(config.get("auth.clientId")),
  corsUrls: config.has("server.corsUrls")
    ? config.get("server.corsUrls")
    : undefined,
  rsvpDeadline,
});

const server = app.listen(port, () => {
  console.log(`Wedding website API listening on port ${port}`);
});

// Cloud Run sends SIGTERM before stopping an instance: let in-flight requests finish, then close the DB.
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
