import type Database from "better-sqlite3";
import { ExpectedError } from "./error-handler.js";
import {
  NOW,
  RSVP_COLUMNS,
  RSVP_INSERT_COLUMNS,
  RSVP_INSERT_VALUES,
  RSVP_UPSERT,
  toRsvp,
  toRsvpParams,
  type Role,
  type Rsvp,
  type RsvpInput,
  type RsvpParams,
  type RsvpRow,
} from "./model.js";

// Every query is scoped through the caller's own guests row (looked up by their Google `sub`),
// so a caller can only ever see or touch their own group.

export type GroupGuest = {
  guestId: number;
  name: string;
  surname: string;
  rsvp: Rsvp | null;
};

export type Group = {
  selfId: number;
  roles: Role[];
  guests: GroupGuest[];
};

type GroupRow = RsvpRow & {
  selfId: number;
  guestId: number;
  name: string;
  surname: string;
};

export const createGuestStore = (db: Database.Database) => {
  const groupStatement = db.prepare<{ sub: string }, GroupRow>(
    `
      SELECT
        caller.guest_id AS selfId,
        guest.guest_id AS guestId,
        guest.name,
        guest.surname,
        ${RSVP_COLUMNS}
      FROM guests AS caller
      JOIN guests AS guest ON guest.group_id = caller.group_id
      LEFT JOIN rsvps AS rsvp ON rsvp.guest_id = guest.guest_id
      WHERE
        caller.google_sub = $sub
      ORDER BY guest.guest_id;
    `,
  );
  const rolesStatement = db
    .prepare<{ sub: string }, Role>(
      `
        SELECT role.role
        FROM guests AS caller
        JOIN guest_roles AS role ON role.guest_id = caller.guest_id
        WHERE
          caller.google_sub = $sub AND
          role.revoked_at IS NULL
        ORDER BY role.role;
      `,
    )
    .pluck();
  const signUpStatement = db.prepare<
    {
      signupUuid: string;
      sub: string;
      email: string;
      tokenName: string | null;
    },
    { guestId: number }
  >(
    `
      UPDATE guests
      SET
        google_sub = $sub,
        email = $email,
        token_name = $tokenName,
        signed_up_at = ${NOW},
        updated_by = guest_id
      WHERE
        sign_up_uuid = $signupUuid AND
        google_sub IS NULL
      RETURNING guest_id AS guestId;
    `,
  );
  const rsvpStatement = db.prepare<
    RsvpParams & { sub: string },
    { guestId: number }
  >(
    `
      INSERT INTO rsvps (${RSVP_INSERT_COLUMNS})
      SELECT target.guest_id, ${RSVP_INSERT_VALUES}, caller.guest_id, ${NOW}
      FROM guests AS caller
      JOIN guests AS target ON target.group_id = caller.group_id
      WHERE
        caller.google_sub = $sub AND
        target.guest_id = $guestId
      ${RSVP_UPSERT};
    `,
  );
  // all or nothing: any guest outside the caller's group rolls back the whole batch
  const submitRsvps = db.transaction((sub: string, rsvps: RsvpInput[]) => {
    rsvps.forEach((rsvp) => {
      if (!rsvpStatement.get({ sub, ...toRsvpParams(rsvp) })) {
        throw new ExpectedError(
          "you can only RSVP for guests in your group",
          403,
        );
      }
    });
  });

  return {
    // undefined when the account isn't bound to any guest yet
    getGroup: (sub: string): Group | undefined => {
      const rows = groupStatement.all({ sub });
      const [first] = rows;
      if (!first) {
        return undefined;
      }
      return {
        selfId: first.selfId,
        roles: rolesStatement.all({ sub }),
        guests: rows.map(({ guestId, name, surname, ...rsvp }) => ({
          guestId,
          name,
          surname,
          rsvp: toRsvp(rsvp),
        })),
      };
    },

    getRoles: (sub: string): Role[] => rolesStatement.all({ sub }),

    // binds the account to an unused invite; undefined when the invite is unknown or already used
    signUp: (params: {
      signupUuid: string;
      sub: string;
      email: string;
      tokenName: string | null;
    }): number | undefined => signUpStatement.get(params)?.guestId,

    submitRsvps: (sub: string, rsvps: RsvpInput[]): void =>
      submitRsvps(sub, rsvps),
  };
};

export type GuestStore = ReturnType<typeof createGuestStore>;
