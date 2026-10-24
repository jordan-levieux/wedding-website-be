CREATE TABLE groups (
    group_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
) STRICT;

CREATE TABLE guests (
    guest_id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups (group_id),
    name TEXT,
    surname TEXT,
    plus_one_of INTEGER REFERENCES guests (guest_id),
    sign_up_uuid TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    email TEXT,
    token_name TEXT,
    signed_up_at TEXT,
    CHECK (plus_one_of IS NOT NULL OR (name IS NOT NULL AND surname IS NOT NULL))
) STRICT;

CREATE INDEX guests_group_id ON guests (group_id);

CREATE TABLE rsvps (
    guest_id INTEGER PRIMARY KEY REFERENCES guests (guest_id),
    attending INTEGER NOT NULL CHECK (attending IN (0, 1)),
    dietary TEXT CHECK (dietary IN ('none', 'vegetarian', 'halaal', 'kosher', 'other')),
    dietary_other_details TEXT,
    shuttle INTEGER CHECK (shuttle IN (0, 1)),
    accommodation INTEGER CHECK (accommodation IN (0, 1)),
    plus_one_name TEXT,
    plus_one_surname TEXT,
    responded_by INTEGER NOT NULL REFERENCES guests (guest_id),
    responded_at TEXT NOT NULL
) STRICT;

CREATE TABLE rsvp_history (
    history_id INTEGER PRIMARY KEY,
    guest_id INTEGER NOT NULL REFERENCES guests (guest_id),
    attending INTEGER NOT NULL,
    dietary TEXT,
    dietary_other_details TEXT,
    shuttle INTEGER,
    accommodation INTEGER,
    plus_one_name TEXT,
    plus_one_surname TEXT,
    responded_by INTEGER NOT NULL REFERENCES guests (guest_id),
    -- set by the trigger, so it can't be faked by whoever writes to rsvps
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
) STRICT;

CREATE INDEX rsvp_history_guest_id ON rsvp_history (guest_id, history_id);

CREATE TRIGGER rsvps_history_insert AFTER INSERT ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle, accommodation,
        plus_one_name, plus_one_surname, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle, NEW.accommodation,
        NEW.plus_one_name, NEW.plus_one_surname, NEW.responded_by
    );
END;

CREATE TRIGGER rsvps_history_update AFTER UPDATE ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle, accommodation,
        plus_one_name, plus_one_surname, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle, NEW.accommodation,
        NEW.plus_one_name, NEW.plus_one_surname, NEW.responded_by
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
        LAG(h.accommodation) OVER w AS prev_accommodation,
        LAG(h.plus_one_name) OVER w AS prev_plus_one_name,
        LAG(h.plus_one_surname) OVER w AS prev_plus_one_surname,
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
            iif(accommodation IS NOT prev_accommodation, 'accommodation', NULL),
            iif(plus_one_name IS NOT prev_plus_one_name OR plus_one_surname IS NOT prev_plus_one_surname, 'plus_one_name', NULL)
        ) AS changed_fields
    FROM history
    WHERE prev_history_id IS NOT NULL
)
SELECT
    c.recorded_at,
    c.guest_id,
    trim(coalesce(guest.name, c.plus_one_name, 'plus-one') || ' ' || coalesce(guest.surname, c.plus_one_surname, '')) AS guest,
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
