CREATE TABLE guests (
    guest_id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    surname TEXT NOT NULL,
    sign_up_uuid TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    email TEXT,
    token_name TEXT,
    signed_up_at TEXT,
    updated_by INTEGER REFERENCES guests (guest_id)
) STRICT;

CREATE INDEX guests_group_id ON guests (group_id);

CREATE TABLE guest_history (
    history_id INTEGER PRIMARY KEY,
    guest_id INTEGER NOT NULL REFERENCES guests (guest_id),
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    surname TEXT NOT NULL,
    sign_up_uuid TEXT,
    google_sub TEXT,
    email TEXT,
    token_name TEXT,
    signed_up_at TEXT,
    updated_by INTEGER REFERENCES guests (guest_id),
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
) STRICT;

CREATE INDEX guest_history_guest_id ON guest_history (guest_id, history_id);

CREATE TRIGGER guests_history_insert AFTER INSERT ON guests BEGIN
    INSERT INTO guest_history (
        guest_id, group_id, name, surname, sign_up_uuid, google_sub, email, token_name, signed_up_at, updated_by
    ) VALUES (
        NEW.guest_id, NEW.group_id, NEW.name, NEW.surname, NEW.sign_up_uuid, NEW.google_sub, NEW.email,
        NEW.token_name, NEW.signed_up_at, NEW.updated_by
    );
END;

CREATE TRIGGER guests_history_update AFTER UPDATE ON guests BEGIN
    INSERT INTO guest_history (
        guest_id, group_id, name, surname, sign_up_uuid, google_sub, email, token_name, signed_up_at, updated_by
    ) VALUES (
        NEW.guest_id, NEW.group_id, NEW.name, NEW.surname, NEW.sign_up_uuid, NEW.google_sub, NEW.email,
        NEW.token_name, NEW.signed_up_at, NEW.updated_by
    );
END;

CREATE TRIGGER guest_history_no_update BEFORE UPDATE ON guest_history BEGIN
    SELECT RAISE(ABORT, 'guest_history is append-only');
END;

CREATE TRIGGER guest_history_no_delete BEFORE DELETE ON guest_history BEGIN
    SELECT RAISE(ABORT, 'guest_history is append-only');
END;

-- revoked roles are kept rather than deleted, so this table is also the audit trail of role changes
CREATE TABLE guest_roles (
    guest_role_id INTEGER PRIMARY KEY,
    guest_id INTEGER NOT NULL REFERENCES guests (guest_id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer', 'venue_accommodation')),
    granted_by INTEGER REFERENCES guests (guest_id),
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    revoked_by INTEGER REFERENCES guests (guest_id),
    revoked_at TEXT
) STRICT;

CREATE UNIQUE INDEX guest_roles_active ON guest_roles (guest_id, role) WHERE revoked_at IS NULL;

CREATE TRIGGER guest_roles_no_delete BEFORE DELETE ON guest_roles BEGIN
    SELECT RAISE(ABORT, 'revoke roles instead of deleting them');
END;

CREATE TRIGGER guest_roles_revoke_only BEFORE UPDATE ON guest_roles
WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.guest_id IS NOT OLD.guest_id
    OR NEW.role IS NOT OLD.role
    OR NEW.granted_by IS NOT OLD.granted_by
    OR NEW.granted_at IS NOT OLD.granted_at
BEGIN
    SELECT RAISE(ABORT, 'roles can only be revoked, once');
END;

CREATE TABLE rsvps (
    guest_id INTEGER PRIMARY KEY REFERENCES guests (guest_id),
    attending INTEGER NOT NULL CHECK (attending IN (0, 1)),
    dietary TEXT CHECK (dietary IN ('none', 'vegetarian', 'halaal', 'kosher', 'other')),
    dietary_other_details TEXT,
    shuttle INTEGER CHECK (shuttle IN (0, 1)),
    accommodation_lat REAL CHECK (accommodation_lat BETWEEN -90 AND 90),
    accommodation_lng REAL CHECK (accommodation_lng BETWEEN -180 AND 180),
    responded_by INTEGER NOT NULL REFERENCES guests (guest_id),
    responded_at TEXT NOT NULL,
    CHECK (attending = 0 OR dietary IS NOT NULL),
    CHECK (dietary IS NOT 'other' OR dietary_other_details IS NOT NULL),
    CHECK ((accommodation_lat IS NULL) = (accommodation_lng IS NULL))
) STRICT;

CREATE TABLE rsvp_history (
    history_id INTEGER PRIMARY KEY,
    guest_id INTEGER NOT NULL REFERENCES guests (guest_id),
    attending INTEGER NOT NULL,
    dietary TEXT,
    dietary_other_details TEXT,
    shuttle INTEGER,
    accommodation_lat REAL,
    accommodation_lng REAL,
    responded_by INTEGER NOT NULL REFERENCES guests (guest_id),
    -- set by the trigger, so it can't be faked by whoever writes to rsvps
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
) STRICT;

CREATE INDEX rsvp_history_guest_id ON rsvp_history (guest_id, history_id);

CREATE TRIGGER rsvps_history_insert AFTER INSERT ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle,
        accommodation_lat, accommodation_lng, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle,
        NEW.accommodation_lat, NEW.accommodation_lng, NEW.responded_by
    );
END;

CREATE TRIGGER rsvps_history_update AFTER UPDATE ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle,
        accommodation_lat, accommodation_lng, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle,
        NEW.accommodation_lat, NEW.accommodation_lng, NEW.responded_by
    );
END;

CREATE TRIGGER rsvp_history_no_update BEFORE UPDATE ON rsvp_history BEGIN
    SELECT RAISE(ABORT, 'rsvp_history is append-only');
END;

CREATE TRIGGER rsvp_history_no_delete BEFORE DELETE ON rsvp_history BEGIN
    SELECT RAISE(ABORT, 'rsvp_history is append-only');
END;

-- Every RSVP update that changed the previous answer, with who gave the old and the new answer.
-- Look up the two history ids in rsvp_history for the full before/after values.
CREATE VIEW rsvp_changes AS
WITH history AS (
    SELECT
        h.*,
        LAG(h.history_id) OVER w AS prev_history_id,
        LAG(h.attending) OVER w AS prev_attending,
        LAG(h.dietary) OVER w AS prev_dietary,
        LAG(h.dietary_other_details) OVER w AS prev_dietary_other_details,
        LAG(h.shuttle) OVER w AS prev_shuttle,
        LAG(h.accommodation_lat) OVER w AS prev_accommodation_lat,
        LAG(h.accommodation_lng) OVER w AS prev_accommodation_lng,
        LAG(h.responded_by) OVER w AS prev_responded_by
    FROM rsvp_history h
    WINDOW w AS (PARTITION BY h.guest_id ORDER BY h.history_id)
),
changes AS (
    SELECT
        *,
        concat_ws(', ',
            iif(attending IS NOT prev_attending, 'attending', NULL),
            iif(dietary IS NOT prev_dietary, 'dietary', NULL),
            iif(dietary_other_details IS NOT prev_dietary_other_details, 'dietary_other_details', NULL),
            iif(shuttle IS NOT prev_shuttle, 'shuttle', NULL),
            iif(accommodation_lat IS NOT prev_accommodation_lat OR accommodation_lng IS NOT prev_accommodation_lng, 'accommodation', NULL)
        ) AS changed_fields
    FROM history
    WHERE prev_history_id IS NOT NULL
)
SELECT
    c.recorded_at,
    c.guest_id,
    guest.name || ' ' || guest.surname AS guest,
    previous_responder.name || ' ' || previous_responder.surname AS previous_answer_by,
    responder.name || ' ' || responder.surname AS changed_by,
    c.changed_fields,
    c.prev_attending AS was_attending,
    c.attending AS now_attending,
    c.prev_history_id,
    c.history_id
FROM changes c
JOIN guests guest ON guest.guest_id = c.guest_id
JOIN guests previous_responder ON previous_responder.guest_id = c.prev_responded_by
JOIN guests responder ON responder.guest_id = c.responded_by
WHERE c.changed_fields <> ''
ORDER BY c.history_id;
