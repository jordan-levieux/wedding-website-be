import type Database from "better-sqlite3";

// Every query is scoped through the caller's own guests row (looked up by their Google `sub`),
// so a caller can only ever see or touch their own group.

export type DietaryOption = "none" | "vegetarian" | "halaal" | "kosher" | "other";

export type Rsvp = {
  attending: boolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: boolean | null;
  accommodation: boolean | null;
  plusOneName: string | null;
  plusOneSurname: string | null;
  respondedBy: number;
  respondedAt: string;
};

export type GroupGuest = {
  guestId: number;
  // null for a plus-one we don't know the name of, see rsvp.plusOneName
  name: string | null;
  surname: string | null;
  plusOneOf: number | null;
  rsvp: Rsvp | null;
};

export type Group = {
  selfId: number;
  groupName: string;
  guests: GroupGuest[];
};

type SqliteBoolean = 0 | 1;

type GroupRow = {
  selfId: number;
  groupName: string;
  guestId: number;
  name: string | null;
  surname: string | null;
  plusOneOf: number | null;
  attending: SqliteBoolean | null;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: SqliteBoolean | null;
  accommodation: SqliteBoolean | null;
  plusOneName: string | null;
  plusOneSurname: string | null;
  respondedBy: number | null;
  respondedAt: string | null;
};

const toBoolean = (value: SqliteBoolean | null) =>
  value === null ? null : value === 1;

const toGroupGuest = (row: GroupRow): GroupGuest => ({
  guestId: row.guestId,
  name: row.name,
  surname: row.surname,
  plusOneOf: row.plusOneOf,
  rsvp:
    row.attending === null
      ? null
      : {
          attending: row.attending === 1,
          dietary: row.dietary,
          dietaryOtherDetails: row.dietaryOtherDetails,
          shuttle: toBoolean(row.shuttle),
          accommodation: toBoolean(row.accommodation),
          plusOneName: row.plusOneName,
          plusOneSurname: row.plusOneSurname,
          respondedBy: row.respondedBy!,
          respondedAt: row.respondedAt!,
        },
});

export const createGuestStore = (db: Database.Database) => {
  const groupStatement = db.prepare<{ sub: string }, GroupRow>(
    `
      SELECT
        caller.guest_id AS selfId,
        groups.name AS groupName,
        guest.guest_id AS guestId,
        guest.name,
        guest.surname,
        guest.plus_one_of AS plusOneOf,
        rsvp.attending,
        rsvp.dietary,
        rsvp.dietary_other_details AS dietaryOtherDetails,
        rsvp.shuttle,
        rsvp.accommodation,
        rsvp.plus_one_name AS plusOneName,
        rsvp.plus_one_surname AS plusOneSurname,
        rsvp.responded_by AS respondedBy,
        rsvp.responded_at AS respondedAt
      FROM guests AS caller
      JOIN groups ON groups.group_id = caller.group_id
      JOIN guests AS guest ON guest.group_id = caller.group_id
      LEFT JOIN rsvps AS rsvp ON rsvp.guest_id = guest.guest_id
      WHERE
        caller.google_sub = $sub
      -- plus-ones straight after the guest who brings them
      ORDER BY
        coalesce(guest.plus_one_of, guest.guest_id),
        guest.plus_one_of IS NOT NULL,
        guest.guest_id;
    `,
  );
  const signUpStatement = db.prepare<
    { signupUuid: string; sub: string; email: string; tokenName: string | null },
    { guestId: number }
  >(
    `
      UPDATE guests
      SET
        google_sub = $sub,
        email = $email,
        token_name = $tokenName,
        signed_up_at = strftime('%Y-%m-%dT%H:%M:%fZ')
      WHERE
        sign_up_uuid = $signupUuid AND
        google_sub IS NULL
      RETURNING guest_id AS guestId;
    `,
  );

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
        groupName: first.groupName,
        guests: rows.map(toGroupGuest),
      };
    },

    // binds the account to an unused invite; undefined when the invite is unknown or already used
    signUp: (params: {
      signupUuid: string;
      sub: string;
      email: string;
      tokenName: string | null;
    }): number | undefined => signUpStatement.get(params)?.guestId,
  };
};

export type GuestStore = ReturnType<typeof createGuestStore>;
