import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import Database from "better-sqlite3";
import { OAuth2Client } from "google-auth-library";
import { errorHandler, ExpectedError } from "./error-handler.js";

const CLIENT_ID =
  "TODO";
const googleClient = new OAuth2Client(CLIENT_ID);
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

app.post(
  "/auth/signup/:signupId",
  (req: Request, res: Response, next: NextFunction) => {
    const authHeader: string | undefined = req.headers.authorization;
    const signupId: string = req.params.signupId! as string;
    checkToken(authHeader)
      .then((tokenPayload) => {
        const userEmail = tokenPayload.email;
        const tokenName = `${tokenPayload.given_name} ${tokenPayload.family_name}`;
        const user = db
          .prepare(
            `
        UPDATE users
        SET
          email = $userEmail,
          token_name = $tokenName
        WHERE
          sign_up_uuid = $signupUuid AND
          email IS NULL
        RETURNING name, surname, email;
      `,
          )
          .get({
            signupUuid: signupId,
            userEmail: userEmail,
            tokenName: tokenName,
          });
        if (!user) {
          return Promise.reject(
            new ExpectedError("sign-up token is invalid or used", 400),
          );
        }
        return res.json(user);
      })
      .catch(next);
  },
);

app.post(
  "/auth/login",
  express.json(),
  (req: Request, res: Response, next: NextFunction) => {
    const authHeader: string | undefined = req.headers.authorization;
    checkToken(authHeader)
      .then((tokenPayload) => {
        const userEmail = tokenPayload.email;
        const userGroup = db
          .prepare(
            `
        SELECT 
          name,
          surname,
          group_id,
          rsvp
        FROM users
        WHERE
          group_id = (SELECT group_id FROM users WHERE email = $userEmail);
      `,
          )
          .all({
            userEmail: userEmail,
          });
        if (!userGroup) {
          return Promise.reject(
            new ExpectedError("sign-up token is invalid or used", 400),
          );
        }
        return res.json(userGroup);
      })
      .catch(next);
  },
);

app.get("/health", (_: Request, res: Response) => {
    db.prepare("SELECT 1").run();
    res.sendStatus(200);
});

app.use(errorHandler);

app.listen(port, () => {
  setupDb();
  console.log(`Example app listening on port ${port}`);
});

const checkToken = (authHeader: string | undefined | null) => {
  if (!authHeader) {
    return Promise.reject(new ExpectedError("no credentials present", 401));
  }
  const idToken: string = authHeader.replace("Bearer ", "");

  return googleClient
    .verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    })
    .then((ticket) => {
      const tokenPayload = ticket.getPayload();
      if (!tokenPayload) {
        return Promise.reject(
          new ExpectedError("invalid token: no payload", 401),
        );
      } else if (!tokenPayload.email) {
        return Promise.reject(
          new ExpectedError("invalid token: no email", 401),
        );
      }
      return tokenPayload;
    });
};
