import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ExpectedError } from "./error-handler.js";
import {
  NOW,
  RSVP_COLUMNS,
  RSVP_INSERT_COLUMNS,
  RSVP_INSERT_VALUES,
  RSVP_UPSERT,
  toBoolean,
  toRsvp,
  toRsvpParams,
  type Role,
  type Rsvp,
  type RsvpInput,
  type RsvpParams,
  type RsvpRow,
  type SqliteBoolean,
} from "./model.js";
import type { GuestUpdateInput, NewGuestInput } from "./validation.js";

// Writes look up the caller's active admin role inside the same transaction as the change, and that
// admin's guest id is what gets recorded in updated_by / responded_by / granted_by / revoked_by.

export type AdminGuest = {
  guestId: number;
  groupId: number;
  name: string;
  surname: string;
  email: string | null;
  tokenName: string | null;
  signUpUuid: string | null;
  signedUpAt: string | null;
  updatedBy: number | null;
  roles: Role[];
  rsvp: Rsvp | null;
};

export type RsvpChange = {
  recordedAt: string;
  guestId: number;
  guest: string;
  previousAnswerBy: string;
  changedBy: string;
  changedFields: string;
  wasAttending: boolean;
  nowAttending: boolean;
  prevHistoryId: number;
  historyId: number;
};

type AdminGuestRow = RsvpRow &
  Omit<AdminGuest, "roles" | "rsvp"> & {
    roles: string;
  };

type RsvpChangeRow = Omit<RsvpChange, "wasAttending" | "nowAttending"> & {
  wasAttending: SqliteBoolean;
  nowAttending: SqliteBoolean;
};

const ADMIN_GUEST_SELECT = `
  SELECT
    guest.guest_id AS guestId,
    guest.group_id AS groupId,
    guest.name,
    guest.surname,
    guest.email,
    guest.token_name AS tokenName,
    guest.sign_up_uuid AS signUpUuid,
    guest.signed_up_at AS signedUpAt,
    guest.updated_by AS updatedBy,
    (
      SELECT json_group_array(role)
      FROM (
        SELECT role
        FROM guest_roles
        WHERE guest_id = guest.guest_id AND revoked_at IS NULL
        ORDER BY role
      )
    ) AS roles,
    ${RSVP_COLUMNS}
  FROM guests AS guest
  LEFT JOIN rsvps AS rsvp ON rsvp.guest_id = guest.guest_id
`;

const toAdminGuest = ({
  guestId,
  groupId,
  name,
  surname,
  email,
  tokenName,
  signUpUuid,
  signedUpAt,
  updatedBy,
  roles,
  ...rsvp
}: AdminGuestRow): AdminGuest => ({
  guestId,
  groupId,
  name,
  surname,
  email,
  tokenName,
  signUpUuid,
  signedUpAt,
  updatedBy,
  roles: JSON.parse(roles) as Role[],
  rsvp: toRsvp(rsvp),
});

export const createAdminStore = (db: Database.Database) => {
  const adminIdStatement = db
    .prepare<{ sub: string }, number>(
      `
        SELECT caller.guest_id
        FROM guests AS caller
        JOIN guest_roles AS role ON role.guest_id = caller.guest_id
        WHERE
          caller.google_sub = $sub AND
          role.role = 'admin' AND
          role.revoked_at IS NULL;
      `,
    )
    .pluck();
  const guestsStatement = db.prepare<[], AdminGuestRow>(
    `${ADMIN_GUEST_SELECT} ORDER BY guest.group_id, guest.guest_id;`,
  );
  const guestStatement = db.prepare<{ guestId: number }, AdminGuestRow>(
    `${ADMIN_GUEST_SELECT} WHERE guest.guest_id = $guestId;`,
  );
  const rsvpChangesStatement = db.prepare<[], RsvpChangeRow>(
    `
      SELECT
        recorded_at AS recordedAt,
        guest_id AS guestId,
        guest,
        previous_answer_by AS previousAnswerBy,
        changed_by AS changedBy,
        changed_fields AS changedFields,
        was_attending AS wasAttending,
        now_attending AS nowAttending,
        prev_history_id AS prevHistoryId,
        history_id AS historyId
      FROM rsvp_changes;
    `,
  );
  const rsvpHistoryStatement = db.prepare<
    { guestId: number },
    Record<string, unknown>
  >(
    `
      SELECT
        history_id AS historyId,
        attending,
        dietary,
        dietary_other_details AS dietaryOtherDetails,
        shuttle,
        accommodation_lat AS accommodationLat,
        accommodation_lng AS accommodationLng,
        responded_by AS respondedBy,
        recorded_at AS recordedAt
      FROM rsvp_history
      WHERE guest_id = $guestId
      ORDER BY history_id;
    `,
  );
  const guestHistoryStatement = db.prepare<
    { guestId: number },
    Record<string, unknown>
  >(
    `
      SELECT
        history_id AS historyId,
        group_id AS groupId,
        name,
        surname,
        sign_up_uuid AS signUpUuid,
        email,
        token_name AS tokenName,
        signed_up_at AS signedUpAt,
        updated_by AS updatedBy,
        recorded_at AS recordedAt
      FROM guest_history
      WHERE guest_id = $guestId
      ORDER BY history_id;
    `,
  );
  const roleHistoryStatement = db.prepare<
    { guestId: number },
    Record<string, unknown>
  >(
    `
      SELECT
        role,
        granted_by AS grantedBy,
        granted_at AS grantedAt,
        revoked_by AS revokedBy,
        revoked_at AS revokedAt
      FROM guest_roles
      WHERE guest_id = $guestId
      ORDER BY guest_role_id;
    `,
  );
  const rsvpStatement = db.prepare<
    RsvpParams & { adminId: number },
    { guestId: number }
  >(
    `
      INSERT INTO rsvps (${RSVP_INSERT_COLUMNS})
      SELECT guest_id, ${RSVP_INSERT_VALUES}, $adminId, ${NOW}
      FROM guests
      WHERE guest_id = $guestId
      ${RSVP_UPSERT};
    `,
  );
  const createGuestStatement = db.prepare<
    {
      groupId: number | null;
      name: string;
      surname: string;
      signUpUuid: string;
      adminId: number;
    },
    { guestId: number }
  >(
    `
      INSERT INTO guests (group_id, name, surname, sign_up_uuid, updated_by)
      VALUES (
        coalesce($groupId, (SELECT coalesce(max(group_id), 0) + 1 FROM guests)),
        $name,
        $surname,
        $signUpUuid,
        $adminId
      )
      RETURNING guest_id AS guestId;
    `,
  );
  const updateGuestStatement = db.prepare<
    {
      guestId: number;
      groupId: number | null;
      name: string | null;
      surname: string | null;
      signUpUuid: string | null;
      unlinkGoogleAccount: SqliteBoolean;
      adminId: number;
    },
    { guestId: number }
  >(
    `
      UPDATE guests
      SET
        group_id = coalesce($groupId, group_id),
        name = coalesce($name, name),
        surname = coalesce($surname, surname),
        sign_up_uuid = coalesce($signUpUuid, sign_up_uuid),
        google_sub = iif($unlinkGoogleAccount, NULL, google_sub),
        email = iif($unlinkGoogleAccount, NULL, email),
        token_name = iif($unlinkGoogleAccount, NULL, token_name),
        signed_up_at = iif($unlinkGoogleAccount, NULL, signed_up_at),
        updated_by = $adminId
      WHERE guest_id = $guestId
      RETURNING guest_id AS guestId;
    `,
  );
  const activeRolesStatement = db
    .prepare<{ guestId: number }, Role>(
      `SELECT role FROM guest_roles WHERE guest_id = $guestId AND revoked_at IS NULL;`,
    )
    .pluck();
  const grantRoleStatement = db.prepare<{
    guestId: number;
    role: Role;
    adminId: number;
  }>(
    `INSERT INTO guest_roles (guest_id, role, granted_by) VALUES ($guestId, $role, $adminId);`,
  );
  const revokeRoleStatement = db.prepare<{
    guestId: number;
    role: Role;
    adminId: number;
  }>(
    `
      UPDATE guest_roles
      SET revoked_by = $adminId, revoked_at = ${NOW}
      WHERE guest_id = $guestId AND role = $role AND revoked_at IS NULL;
    `,
  );

  const requireAdminId = (sub: string): number => {
    const adminId = adminIdStatement.get({ sub });
    if (adminId === undefined) {
      throw new ExpectedError("admin role required", 403);
    }
    return adminId;
  };

  const getGuest = (guestId: number): AdminGuest => {
    const row = guestStatement.get({ guestId });
    if (!row) {
      throw new ExpectedError(`guest ${guestId} not found`, 404);
    }
    return toAdminGuest(row);
  };

  const setRoles = (adminId: number, guestId: number, roles: Role[]) => {
    if (guestId === adminId && !roles.includes("admin")) {
      throw new ExpectedError("you can't remove your own admin role", 400);
    }
    const current = activeRolesStatement.all({ guestId });
    current
      .filter((role) => !roles.includes(role))
      .forEach((role) => revokeRoleStatement.run({ guestId, role, adminId }));
    roles
      .filter((role) => !current.includes(role))
      .forEach((role) => grantRoleStatement.run({ guestId, role, adminId }));
  };

  // no deadline for admins; recorded as answered by the admin
  const submitRsvps = db.transaction((sub: string, rsvps: RsvpInput[]) => {
    const adminId = requireAdminId(sub);
    rsvps.forEach((rsvp) => {
      if (!rsvpStatement.get({ adminId, ...toRsvpParams(rsvp) })) {
        throw new ExpectedError(`guest ${rsvp.guestId} not found`, 404);
      }
    });
  });

  const createGuest = db.transaction(
    (sub: string, guest: NewGuestInput): AdminGuest => {
      const adminId = requireAdminId(sub);
      const { guestId } = createGuestStatement.get({
        groupId: guest.groupId,
        name: guest.name,
        surname: guest.surname,
        signUpUuid: randomUUID(),
        adminId,
      })!;
      setRoles(adminId, guestId, guest.roles);
      return getGuest(guestId);
    },
  );

  const updateGuest = db.transaction(
    (sub: string, guestId: number, update: GuestUpdateInput): AdminGuest => {
      const adminId = requireAdminId(sub);
      getGuest(guestId);
      const changesDetails =
        update.groupId !== null ||
        update.name !== null ||
        update.surname !== null ||
        update.regenerateInvite ||
        update.unlinkGoogleAccount;
      if (changesDetails) {
        updateGuestStatement.get({
          guestId,
          groupId: update.groupId,
          name: update.name,
          surname: update.surname,
          signUpUuid: update.regenerateInvite ? randomUUID() : null,
          unlinkGoogleAccount: update.unlinkGoogleAccount ? 1 : 0,
          adminId,
        });
      }
      if (update.roles !== null) {
        setRoles(adminId, guestId, update.roles);
      }
      return getGuest(guestId);
    },
  );

  return {
    // invites let whoever holds them claim a guest, so only admins see them
    listGuests: (includeInvites: boolean): AdminGuest[] =>
      guestsStatement
        .all()
        .map(toAdminGuest)
        .map((guest) =>
          includeInvites ? guest : { ...guest, signUpUuid: null },
        ),

    getGuest,

    listRsvpChanges: (): RsvpChange[] =>
      rsvpChangesStatement.all().map((row) => ({
        ...row,
        wasAttending: toBoolean(row.wasAttending)!,
        nowAttending: toBoolean(row.nowAttending)!,
      })),

    getGuestHistory: (guestId: number, includeInvites: boolean) => {
      getGuest(guestId);
      return {
        details: guestHistoryStatement
          .all({ guestId })
          .map((row) => (includeInvites ? row : { ...row, signUpUuid: null })),
        roles: roleHistoryStatement.all({ guestId }),
        rsvps: rsvpHistoryStatement.all({ guestId }),
      };
    },

    submitRsvps: (sub: string, rsvps: RsvpInput[]): void =>
      submitRsvps(sub, rsvps),

    createGuest: (sub: string, guest: NewGuestInput): AdminGuest =>
      createGuest(sub, guest),

    updateGuest: (
      sub: string,
      guestId: number,
      update: GuestUpdateInput,
    ): AdminGuest => updateGuest(sub, guestId, update),
  };
};

export type AdminStore = ReturnType<typeof createAdminStore>;
