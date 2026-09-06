import express, { type Express, type Request, type Response } from "express";
import Database from "better-sqlite3";

const app: Express = express();
const port = 3000;
const db = new Database("db/app.db");
db.pragma("journal_mode = WAL");

const setupDb = () => {
  try {
    db.prepare(
      `
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY
        )
      `,
    ).run();
  } catch (error) {
    console.error("encountered error setting up db: ", error);
  }
};

app.get("/users", (_: Request, res: Response) => {
  const allUserNames = db.prepare("SELECT username FROM users").all();
  res.json({
    users: allUserNames,
  });
});

app.post("/user", express.json(), (req: Request, res: Response) => {
  const validUserName =
    req.body.userName &&
    typeof req.body.userName === "string" &&
    req.body.userName.length > 0;
  if (!validUserName) {
    res.status(400).json({ errorMessage: "userName is missing or not valid" });
  } else {
    try {
      db.prepare("INSERT INTO users (username) VALUES (?)").run(
        req.body.userName,
      );
      res.sendStatus(201);
    } catch (error: any) {
      if (
        error?.message &&
        typeof error.message === "string" &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        res.status(400).json({ errorMessage: "userName already exists" });
      } else {
        res.sendStatus(500);
      }
    }
  }
});

app.get("/", (_: Request, res: Response) => {
  res.send("Hello World!\n");
});

app.listen(port, () => {
  setupDb();
  console.log(`Example app listening on port ${port}`);
});
