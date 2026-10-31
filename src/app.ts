import type Database from "better-sqlite3";
import cors from "cors";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createAdminRouter } from "./admin-routes.js";
import type { AdminStore } from "./admin-store.js";
import { getIdentity } from "./auth.js";
import { errorHandler, ExpectedError } from "./error-handler.js";
import type { Group, GuestStore } from "./guest-store.js";
import {
  parseAccommodation,
  parseGuestId,
  parseRsvpBatch,
} from "./validation.js";

export const createApp = (deps: {
  db: Database.Database;
  store: GuestStore;
  adminStore: AdminStore;
  authenticate: RequestHandler;
  corsUrls: string[] | undefined;
  rsvpDeadline: Date;
}): Express => {
  const { db, store, adminStore, authenticate, corsUrls, rsvpDeadline } = deps;
  const app: Express = express();
  const dbHealthCheck = db.prepare("SELECT 1");

  const groupResponse = (group: Group) => ({
    ...group,
    rsvpDeadline: rsvpDeadline.toISOString(),
  });

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
    res.json(groupResponse(group));
  });

  app.get("/group", authenticate, (_req: Request, res: Response) => {
    const group = store.getGroup(getIdentity(res).sub);
    if (!group) {
      throw new ExpectedError("user is not registered", 403);
    }
    res.json(groupResponse(group));
  });

  app.put(
    "/rsvp",
    authenticate,
    express.json(),
    (req: Request, res: Response) => {
      const sub = getIdentity(res).sub;
      if (Date.now() > rsvpDeadline.getTime()) {
        throw new ExpectedError("the RSVP deadline has passed", 403);
      }
      store.submitRsvps(sub, parseRsvpBatch(req.body));
      res.json(groupResponse(store.getGroup(sub)!));
    },
  );

  // where people are staying can still change after the RSVP deadline
  app.put(
    "/accommodation",
    authenticate,
    express.json(),
    (req: Request, res: Response) => {
      const sub = getIdentity(res).sub;
      store.setGroupAccommodation(sub, parseAccommodation(req.body));
      res.json(groupResponse(store.getGroup(sub)!));
    },
  );

  app.put(
    "/accommodation/:guestId",
    authenticate,
    express.json(),
    (req: Request<{ guestId: string }>, res: Response) => {
      const sub = getIdentity(res).sub;
      store.setOwnAccommodation(
        sub,
        parseGuestId(req.params.guestId),
        parseAccommodation(req.body),
      );
      res.json(groupResponse(store.getGroup(sub)!));
    },
  );

  app.use("/admin", createAdminRouter({ store, adminStore, authenticate }));

  app.get("/health", (_: Request, res: Response) => {
    dbHealthCheck.get();
    res.sendStatus(200);
  });

  app.use(errorHandler);

  return app;
};
