import Database from "better-sqlite3";
import config from "config";
import cors from "cors";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { errorHandler, ExpectedError } from "./error-handler.js";

const CLIENT_ID: string = config.get("auth.clientId");
const googleClient = new OAuth2Client(CLIENT_ID);
const app: Express = express();
const port: number = config.get("server.port");
const db = new Database(config.get("db.sqliteFilePath"));
const dbHealthCheck = db.prepare("SELECT 1");
const dbSignUpUser = db.prepare(
  `
    UPDATE users
    SET
      email = $userEmail,
      token_name = $tokenName
    WHERE
      sign_up_uuid = $signupUuid AND
      email IS NULL
    RETURNING email;
  `,
);
const dbUserGroupStatement = db.prepare(
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
);

const signUpUser = (params: {
  signupUuid: string;
  userEmail: string;
  tokenName: string;
}) =>
  dbSignUpUser.get({
    signupUuid: params.signupUuid,
    userEmail: params.userEmail,
    tokenName: params.tokenName,
  });

const queryUserGroup = (userEmail: string) =>
  dbUserGroupStatement.all({ userEmail });

db.pragma("journal_mode = WAL");

if (config.has("server.corsUrls")) {
  app.use(cors({ origin: config.get("server.corsUrls") }));
}

app.post(
  "/auth/login",
  express.json(),
  (req: Request, res: Response, next: NextFunction) => {
    const authHeader: string | undefined = req.headers.authorization;
    const signupId = req.query.signupId;
    checkToken(authHeader)
      .then((tokenPayload) => {
        const userEmail = tokenPayload.email!;
        let userGroup = queryUserGroup(userEmail);
        console.log("userGroup:", userGroup);
        console.log("signUpId:", signupId)
        if (!userGroup?.length && signupId && typeof signupId === "string") {
          const tokenName = `${tokenPayload.given_name} ${tokenPayload.family_name}`;
          const user = signUpUser({
            signupUuid: signupId,
            userEmail,
            tokenName,
          });
          console.log("user: ", user)
          if (!user) {
            return Promise.reject(
              new ExpectedError("sign-up token is invalid or used", 400),
            );
          } else {
            userGroup = queryUserGroup(userEmail);
          }
        }
        if (!userGroup?.length) {
          return Promise.reject(
            new ExpectedError("user is not registered", 403),
          );
        }
        return userGroup;
      })
      .then((userGroup) => res.json(userGroup))
      .catch(next);
  },
);

app.get("/health", (_: Request, res: Response) => {
  dbHealthCheck.run();
  res.sendStatus(200);
});

app.use(errorHandler);

app.listen(port, () => {
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
