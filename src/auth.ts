import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { ExpectedError } from "./error-handler.js";

export type Identity = {
  // Google's stable account id; unlike the email it never changes
  sub: string;
  email: string;
  name: string | null;
};

// Verifies the Google ID token in the Authorization header and stores the caller's identity in res.locals.
export const googleAuth = (clientId: string) => {
  const googleClient = new OAuth2Client(clientId);

  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader: string | undefined = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      next(new ExpectedError("no credentials present", 401));
      return;
    }

    // Fetched separately so a Google outage is a 503 rather than a 401 that sends the user round the
    // login loop; the client caches the certs, so this rarely hits the network.
    googleClient
      .getFederatedSignonCertsAsync()
      .catch((error: unknown) =>
        Promise.reject(
          new ExpectedError(
            "couldn't reach Google to verify the login, please try again",
            503,
            {
              cause: error,
            },
          ),
        ),
      )
      .then(() =>
        googleClient
          .verifyIdToken({
            idToken: authHeader.slice("Bearer ".length),
            audience: clientId,
          })
          .catch((error: unknown) =>
            Promise.reject(
              new ExpectedError("invalid token", 401, { cause: error }),
            ),
          ),
      )
      .then((ticket) => ticket.getPayload())
      .then((tokenPayload) => {
        if (!tokenPayload?.email || !tokenPayload.email_verified) {
          throw new ExpectedError("invalid token: no verified email", 401);
        }
        const identity: Identity = {
          sub: tokenPayload.sub,
          email: tokenPayload.email,
          name: tokenPayload.name ?? null,
        };
        res.locals.identity = identity;
        next();
      })
      .catch(next);
  };
};

export const getIdentity = (res: Response): Identity => {
  const identity: Identity | undefined = res.locals.identity;
  if (!identity) {
    throw new ExpectedError("no credentials present", 401);
  }
  return identity;
};
