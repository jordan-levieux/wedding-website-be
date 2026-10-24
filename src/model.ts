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
  accommodation: Coordinates | null;
  respondedBy: number;
  respondedAt: string;
};

export type RsvpInput = {
  guestId: number;
  attending: boolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: boolean | null;
  accommodation: Coordinates | null;
};

export type SqliteBoolean = 0 | 1;

// the columns selected by RSVP_COLUMNS; all null when the guest hasn't responded
export type RsvpRow = {
  attending: SqliteBoolean | null;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: SqliteBoolean | null;
  accommodationLat: number | null;
  accommodationLng: number | null;
  respondedBy: number | null;
  respondedAt: string | null;
};

export const RSVP_COLUMNS = `
  rsvp.attending,
  rsvp.dietary,
  rsvp.dietary_other_details AS dietaryOtherDetails,
  rsvp.shuttle,
  rsvp.accommodation_lat AS accommodationLat,
  rsvp.accommodation_lng AS accommodationLng,
  rsvp.responded_by AS respondedBy,
  rsvp.responded_at AS respondedAt
`;

export type RsvpParams = {
  guestId: number;
  attending: SqliteBoolean;
  dietary: DietaryOption | null;
  dietaryOtherDetails: string | null;
  shuttle: SqliteBoolean | null;
  accommodationLat: number | null;
  accommodationLng: number | null;
};

// for an `INSERT INTO rsvps (...) SELECT <guest_id>, ${RSVP_INSERT_VALUES}, <responded_by>, <responded_at> ...`
export const RSVP_INSERT_COLUMNS = `
  guest_id, attending, dietary, dietary_other_details, shuttle,
  accommodation_lat, accommodation_lng, responded_by, responded_at
`;

export const RSVP_INSERT_VALUES = `
  $attending, $dietary, $dietaryOtherDetails, $shuttle, $accommodationLat, $accommodationLng
`;

export const RSVP_UPSERT = `
  ON CONFLICT (guest_id) DO UPDATE SET
    attending = excluded.attending,
    dietary = excluded.dietary,
    dietary_other_details = excluded.dietary_other_details,
    shuttle = excluded.shuttle,
    accommodation_lat = excluded.accommodation_lat,
    accommodation_lng = excluded.accommodation_lng,
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
        accommodation:
          row.accommodationLat === null || row.accommodationLng === null
            ? null
            : { lat: row.accommodationLat, lng: row.accommodationLng },
        respondedBy: row.respondedBy!,
        respondedAt: row.respondedAt!,
      };

export const toRsvpParams = (rsvp: RsvpInput): RsvpParams => ({
  guestId: rsvp.guestId,
  attending: toSqliteBoolean(rsvp.attending),
  dietary: rsvp.dietary,
  dietaryOtherDetails: rsvp.dietaryOtherDetails,
  shuttle: rsvp.shuttle === null ? null : toSqliteBoolean(rsvp.shuttle),
  accommodationLat: rsvp.accommodation?.lat ?? null,
  accommodationLng: rsvp.accommodation?.lng ?? null,
});
