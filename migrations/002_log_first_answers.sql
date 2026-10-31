-- The change views also list first answers and first pins, not only changes to them.

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
            iif(shuttle IS NOT prev_shuttle, 'shuttle', NULL)
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

DROP VIEW accommodation_changes;

-- Every place being pinned, moved or cleared, with who set the old and the new one (NULL when there was
-- no earlier entry). Saving the same place again isn't listed.
CREATE VIEW accommodation_changes AS
WITH history AS (
    SELECT
        h.*,
        LAG(h.history_id) OVER w AS prev_history_id,
        LAG(h.lat) OVER w AS prev_lat,
        LAG(h.lng) OVER w AS prev_lng,
        LAG(h.updated_by) OVER w AS prev_updated_by
    FROM accommodation_history h
    WINDOW w AS (PARTITION BY h.group_id, h.guest_id ORDER BY h.history_id)
)
SELECT
    h.recorded_at,
    h.group_id,
    h.guest_id,
    previous_setter.name || ' ' || previous_setter.surname AS previous_set_by,
    setter.name || ' ' || setter.surname AS changed_by,
    h.prev_lat IS NOT NULL AS had_place,
    h.lat IS NOT NULL AS has_place,
    h.prev_history_id,
    h.history_id
FROM history h
LEFT JOIN guests previous_setter ON previous_setter.guest_id = h.prev_updated_by
JOIN guests setter ON setter.guest_id = h.updated_by
WHERE h.lat IS NOT h.prev_lat OR h.lng IS NOT h.prev_lng
ORDER BY h.history_id;
