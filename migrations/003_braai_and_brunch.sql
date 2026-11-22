-- Optional answers for the braai on Friday 12 March and the brunch on Sunday 14 March, asked alongside
-- the shuttle for guests who are coming to the wedding.

ALTER TABLE rsvps ADD COLUMN braai INTEGER CHECK (braai IN (0, 1));
ALTER TABLE rsvps ADD COLUMN brunch INTEGER CHECK (brunch IN (0, 1));

ALTER TABLE rsvp_history ADD COLUMN braai INTEGER;
ALTER TABLE rsvp_history ADD COLUMN brunch INTEGER;

DROP TRIGGER rsvps_history_insert;
DROP TRIGGER rsvps_history_update;

CREATE TRIGGER rsvps_history_insert AFTER INSERT ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle, braai, brunch, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle, NEW.braai,
        NEW.brunch, NEW.responded_by
    );
END;

CREATE TRIGGER rsvps_history_update AFTER UPDATE ON rsvps BEGIN
    INSERT INTO rsvp_history (
        guest_id, attending, dietary, dietary_other_details, shuttle, braai, brunch, responded_by
    ) VALUES (
        NEW.guest_id, NEW.attending, NEW.dietary, NEW.dietary_other_details, NEW.shuttle, NEW.braai,
        NEW.brunch, NEW.responded_by
    );
END;

DROP VIEW rsvp_changes;

-- Every RSVP answer: the first one for each guest, then each update that changed it, with who gave the
-- old and the new answer (NULL for a first answer). Look up the two history ids in rsvp_history for the
-- full before/after values.
CREATE VIEW rsvp_changes AS
WITH history AS (
    SELECT
        h.*,
        LAG(h.history_id) OVER w AS prev_history_id,
        LAG(h.attending) OVER w AS prev_attending,
        LAG(h.dietary) OVER w AS prev_dietary,
        LAG(h.dietary_other_details) OVER w AS prev_dietary_other_details,
        LAG(h.shuttle) OVER w AS prev_shuttle,
        LAG(h.braai) OVER w AS prev_braai,
        LAG(h.brunch) OVER w AS prev_brunch,
        LAG(h.responded_by) OVER w AS prev_responded_by
    FROM rsvp_history h
    WINDOW w AS (PARTITION BY h.guest_id ORDER BY h.history_id)
),
changes AS (
    SELECT
        *,
        iif(prev_history_id IS NULL, '', concat_ws(', ',
            iif(attending IS NOT prev_attending, 'attending', NULL),
            iif(dietary IS NOT prev_dietary, 'dietary', NULL),
            iif(dietary_other_details IS NOT prev_dietary_other_details, 'dietary_other_details', NULL),
            iif(shuttle IS NOT prev_shuttle, 'shuttle', NULL),
            iif(braai IS NOT prev_braai, 'braai', NULL),
            iif(brunch IS NOT prev_brunch, 'brunch', NULL)
        )) AS changed_fields
    FROM history
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
LEFT JOIN guests previous_responder ON previous_responder.guest_id = c.prev_responded_by
JOIN guests responder ON responder.guest_id = c.responded_by
WHERE c.prev_history_id IS NULL OR c.changed_fields <> ''
ORDER BY c.history_id;
