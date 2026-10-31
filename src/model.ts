export const DIETARY_OPTIONS = [
  "none",
  "vegetarian",
  "halaal",
  "kosher",
  "other",
] as const;
export type DietaryOption = (typeof DIETARY_OPTIONS)[number];

export const ROLES = ["admin", "viewer", "venue_accommodation"] as const;
export type Role = (typeof ROLES)[number];

export type Coordinates = {
  lat: number;
  lng: number;
};

export type Rsvp = {
  attending: boolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: boolean | null;
  respondedBy: number;
  respondedAt: string;
};

export type RsvpInput = {
  guestId: number;
  attending: boolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: boolean | null;
};

export type SqliteBoolean = 0 | 1;

// the columns selected by RSVP_COLUMNS; all null when the guest hasn't responded
export type RsvpRow = {
  attending: SqliteBoolean | null;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: SqliteBoolean | null;
  respondedBy: number | null;
  respondedAt: string | null;
};

export const RSVP_COLUMNS = `
  rsvp.attending,
  rsvp.dietary,
  rsvp.dietary_other_details AS dietaryOtherDetails,
  rsvp.shuttle,
  rsvp.responded_by AS respondedBy,
  rsvp.responded_at AS respondedAt
`;

export type RsvpParams = {
  guestId: number;
  attending: SqliteBoolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: SqliteBoolean | null;
};

// for an `INSERT INTO rsvps (...) SELECT <guest_id>, ${RSVP_INSERT_VALUES}, <responded_by>, <responded_at> ...`
export const RSVP_INSERT_COLUMNS = `
  guest_id, attending, dietary, dietary_other_details, shuttle, responded_by, responded_at
`;

export const RSVP_INSERT_VALUES = `
  $attending, $dietary, $dietaryOtherDetails, $shuttle
`;

export const RSVP_UPSERT = `
  ON CONFLICT (guest_id) DO UPDATE SET
    attending = excluded.attending,
    dietary = excluded.dietary,
    dietary_other_details = excluded.dietary_other_details,
    shuttle = excluded.shuttle,
    responded_by = excluded.responded_by,
    responded_at = excluded.responded_at
  RETURNING guest_id AS guestId
`;

export const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ')`;

export const toBoolean = (value: SqliteBoolean | null) =>
  value === null ? null : value === 1;

export const toSqliteBoolean = (value: boolean): SqliteBoolean =>
  value ? 1 : 0;

export const toRsvp = (row: RsvpRow): Rsvp | null =>
  row.attending === null
    ? null
    : {
        attending: row.attending === 1,
        dietary: row.dietary,
        dietaryOtherDetails: row.dietaryOtherDetails,
        shuttle: toBoolean(row.shuttle),
        respondedBy: row.respondedBy!,
        respondedAt: row.respondedAt!,
      };

export const toRsvpParams = (rsvp: RsvpInput): RsvpParams => ({
  guestId: rsvp.guestId,
  attending: toSqliteBoolean(rsvp.attending),
  dietary: rsvp.dietary,
  dietaryOtherDetails: rsvp.dietaryOtherDetails,
  shuttle: rsvp.shuttle === null ? null : toSqliteBoolean(rsvp.shuttle),
});

export const toCoordinates = (
  lat: number | null,
  lng: number | null,
): Coordinates | null => (lat === null || lng === null ? null : { lat, lng });

// for an upsert into group_accommodation or guest_accommodation, keyed on $id
export const accommodationUpsert = (table: string, key: string) => `
  INSERT INTO ${table} (${key}, lat, lng, updated_by, updated_at)
  VALUES ($id, $lat, $lng, $updatedBy, ${NOW})
  ON CONFLICT (${key}) DO UPDATE SET
    lat = excluded.lat,
    lng = excluded.lng,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
`;

export type AccommodationParams = {
  id: number;
  lat: number | null;
  lng: number | null;
  updatedBy: number;
};
