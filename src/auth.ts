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
      return next(new ExpectedError("no credentials present", 401));
    }

    googleClient
      .verifyIdToken({
        idToken: authHeader.slice("Bearer ".length),
        audience: clientId,
      })
      .then(
        (ticket) => ticket.getPayload(),
        // expired, malformed or forged tokens: a 401 lets the FE know to log in again
        (error: unknown) =>
          Promise.reject(new ExpectedError("invalid token", 401, { cause: error })),
      )
      .then((tokenPayload) => {
        if (!tokenPayload?.email || !tokenPayload.email_verified) {
          return Promise.reject(
            new ExpectedError("invalid token: no verified email", 401),
          );
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
