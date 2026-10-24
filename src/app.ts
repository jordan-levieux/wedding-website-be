import type Database from "better-sqlite3";
import cors from "cors";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { getIdentity } from "./auth.js";
import { errorHandler, ExpectedError } from "./error-handler.js";
import type { GuestStore } from "./guest-store.js";

export const createApp = (deps: {
  db: Database.Database;
  store: GuestStore;
  authenticate: RequestHandler;
  corsUrls: string[] | undefined;
}): Express => {
  const { db, store, authenticate, corsUrls } = deps;
  const app: Express = express();
  const dbHealthCheck = db.prepare("SELECT 1");

  if (corsUrls) {
    console.log("cors URLs: ", corsUrls);
    app.use(cors({ origin: corsUrls }));
  } else {
    console.error("no Cors config found");
  }

  app.post("/auth/login", authenticate, (req: Request, res: Response) => {
    const identity = getIdentity(res);
    const signupId = req.query.signupId;
    let group = store.getGroup(identity.sub);
    if (!group && signupId && typeof signupId === "string") {
      const guestId = store.signUp({
        signupUuid: signupId,
        sub: identity.sub,
        email: identity.email,
        tokenName: identity.name,
      });
      if (guestId === undefined) {
        throw new ExpectedError("sign-up token is invalid or used", 400);
      }
      group = store.getGroup(identity.sub);
    }
    if (!group) {
      throw new ExpectedError("user is not registered", 403);
    }
    res.json(group);
  });

  app.get("/health", (_: Request, res: Response) => {
    dbHealthCheck.get();
    res.sendStatus(200);
  });

  app.use(errorHandler);

  return app;
};
