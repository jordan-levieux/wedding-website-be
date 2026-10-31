import type Database from "better-sqlite3";
import { ExpectedError } from "./error-handler.js";
import {
  accommodationUpsert,
  NOW,
  RSVP_COLUMNS,
  RSVP_INSERT_COLUMNS,
  RSVP_INSERT_VALUES,
  RSVP_UPSERT,
  toCoordinates,
  toRsvp,
  toRsvpParams,
  type AccommodationParams,
  type Coordinates,
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
  // where this guest is staying when it isn't with the rest of the group
  ownAccommodation: Coordinates | null;
};

export type Group = {
  selfId: number;
  roles: Role[];
  accommodation: Coordinates | null;
  guests: GroupGuest[];
};

type GroupRow = RsvpRow & {
  selfId: number;
  guestId: number;
  name: string;
  surname: string;
  groupLat: number | null;
  groupLng: number | null;
  ownLat: number | null;
  ownLng: number | null;
};

export const createGuestStore = (db: Database.Database) => {
  const groupStatement = db.prepare<{ sub: string }, GroupRow>(
    `
      SELECT
        caller.guest_id AS selfId,
        guest.guest_id AS guestId,
        guest.name,
        guest.surname,
        ${RSVP_COLUMNS},
        group_place.lat AS groupLat,
        group_place.lng AS groupLng,
        own_place.lat AS ownLat,
        own_place.lng AS ownLng
      FROM guests AS caller
      JOIN guests AS guest ON guest.group_id = caller.group_id
      LEFT JOIN rsvps AS rsvp ON rsvp.guest_id = guest.guest_id
      LEFT JOIN group_accommodation AS group_place ON group_place.group_id = caller.group_id
      LEFT JOIN guest_accommodation AS own_place ON own_place.guest_id = guest.guest_id
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
  const callerStatement = db.prepare<
    { sub: string },
    { guestId: number; groupId: number }
  >(
    `SELECT guest_id AS guestId, group_id AS groupId FROM guests WHERE google_sub = $sub;`,
  );
  const groupAccommodationStatement = db.prepare<AccommodationParams>(
    accommodationUpsert("group_accommodation", "group_id"),
  );
  const guestAccommodationStatement = db.prepare<AccommodationParams>(
    accommodationUpsert("guest_accommodation", "guest_id"),
  );
  const groupMateStatement = db
    .prepare<{ guestId: number; groupId: number }, number>(
      `SELECT guest_id FROM guests WHERE guest_id = $guestId AND group_id = $groupId;`,
    )
    .pluck();

  const requireCaller = (sub: string) => {
    const caller = callerStatement.get({ sub });
    if (!caller) {
      throw new ExpectedError("user is not registered", 403);
    }
    return caller;
  };

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
        accommodation: toCoordinates(first.groupLat, first.groupLng),
        guests: rows.map(
          ({ guestId, name, surname, ownLat, ownLng, ...rsvp }) => ({
            guestId,
            name,
            surname,
            rsvp: toRsvp(rsvp),
            ownAccommodation: toCoordinates(ownLat, ownLng),
          }),
        ),
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

    // null clears it
    setGroupAccommodation: (sub: string, place: Coordinates | null): void => {
      const caller = requireCaller(sub);
      groupAccommodationStatement.run({
        id: caller.groupId,
        lat: place?.lat ?? null,
        lng: place?.lng ?? null,
        updatedBy: caller.guestId,
      });
    },

    // null puts the guest back with the rest of the group
    setOwnAccommodation: (
      sub: string,
      guestId: number,
      place: Coordinates | null,
    ): void => {
      const caller = requireCaller(sub);
      if (
        groupMateStatement.get({ guestId, groupId: caller.groupId }) ===
        undefined
      ) {
        throw new ExpectedError(
          "you can only say where guests in your group are staying",
          403,
        );
      }
      guestAccommodationStatement.run({
        id: guestId,
        lat: place?.lat ?? null,
        lng: place?.lng ?? null,
        updatedBy: caller.guestId,
      });
    },
  };
};

export type GuestStore = ReturnType<typeof createGuestStore>;
