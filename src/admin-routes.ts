import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import type { AdminStore } from "./admin-store.js";
import { getIdentity } from "./auth.js";
import { ExpectedError } from "./error-handler.js";
import type { GuestStore } from "./guest-store.js";
import type { Role } from "./model.js";
import {
  parseAccommodation,
  parseGroupId,
  parseGuestId,
  parseGuestUpdate,
  parseNewGuest,
  parseRsvpBatch,
} from "./validation.js";

const requireRole =
  (store: GuestStore, ...allowed: Role[]) =>
  (_req: Request, res: Response, next: NextFunction) => {
    const roles = store.getRoles(getIdentity(res).sub);
    if (!roles.some((role) => allowed.includes(role))) {
      throw new ExpectedError(
        `requires one of the roles: ${allowed.join(", ")}`,
        403,
      );
    }
    res.locals.roles = roles;
    next();
  };

const isAdmin = (res: Response) =>
  (res.locals.roles as Role[]).includes("admin");

export const createAdminRouter = (deps: {
  store: GuestStore;
  adminStore: AdminStore;
  authenticate: RequestHandler;
}): Router => {
  const { store, adminStore, authenticate } = deps;
  const router = express.Router();
  const canView = requireRole(store, "admin", "viewer");
  const canEdit = requireRole(store, "admin");

  router.use(authenticate);

  router.get("/guests", canView, (_req: Request, res: Response) => {
    res.json(adminStore.listGuests(isAdmin(res)));
  });

  router.get(
    "/guests/:guestId/history",
    canView,
    (req: Request<{ guestId: string }>, res: Response) => {
      res.json(
        adminStore.getGuestHistory(
          parseGuestId(req.params.guestId),
          isAdmin(res),
        ),
      );
    },
  );

  router.get("/rsvp-changes", canView, (_req: Request, res: Response) => {
    res.json(adminStore.listRsvpChanges());
  });

  router.get(
    "/accommodation-changes",
    canView,
    (_req: Request, res: Response) => {
      res.json(adminStore.listAccommodationChanges());
    },
  );

  router.put(
    "/groups/:groupId/accommodation",
    canEdit,
    express.json(),
    (req: Request<{ groupId: string }>, res: Response) => {
      adminStore.setGroupAccommodation(
        getIdentity(res).sub,
        parseGroupId(req.params.groupId),
        parseAccommodation(req.body),
      );
      res.json(adminStore.listGuests(true));
    },
  );

  router.put(
    "/guests/:guestId/accommodation",
    canEdit,
    express.json(),
    (req: Request<{ guestId: string }>, res: Response) => {
      adminStore.setOwnAccommodation(
        getIdentity(res).sub,
        parseGuestId(req.params.guestId),
        parseAccommodation(req.body),
      );
      res.json(adminStore.listGuests(true));
    },
  );

  router.put(
    "/rsvps",
    canEdit,
    express.json(),
    (req: Request, res: Response) => {
      adminStore.submitRsvps(getIdentity(res).sub, parseRsvpBatch(req.body));
      res.json(adminStore.listGuests(true));
    },
  );

  router.post(
    "/guests",
    canEdit,
    express.json(),
    (req: Request, res: Response) => {
      res
        .status(201)
        .json(
          adminStore.createGuest(getIdentity(res).sub, parseNewGuest(req.body)),
        );
    },
  );

  router.patch(
    "/guests/:guestId",
    canEdit,
    express.json(),
    (req: Request<{ guestId: string }>, res: Response) => {
      res.json(
        adminStore.updateGuest(
          getIdentity(res).sub,
          parseGuestId(req.params.guestId),
          parseGuestUpdate(req.body),
        ),
      );
    },
  );

  return router;
};
