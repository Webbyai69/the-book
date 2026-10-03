/*
 * Every booking change writes one event, a notification for each member of
 * both participating profiles, and an outbox row per notification for the
 * delivery worker. All three commit with the change itself.
 */

export async function appendEvent(client, booking, actor, type, reason = null, extra = {}) {
  const payload = {
    bookingId: booking.id,
    version: booking.version,
    termsRevision: booking.terms_revision,
    status: booking.status,
    reason,
    ...extra
  };

  const event = await client.query(
    `INSERT INTO book.booking_events (
       booking_id, actor_user_id, actor_profile_id, type, payload
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [booking.id, actor.userId, actor.profileId, type, JSON.stringify(payload)]
  );

  const notifications = await client.query(
    `INSERT INTO book.notifications (
       event_id, recipient_user_id, profile_id, type, payload
     )
     SELECT $1, m.user_id, m.profile_id, $2, $3::jsonb
     FROM book.profile_memberships m
     WHERE m.profile_id = ANY($4::uuid[])
       -- Nobody is notified of their own action.
       AND m.user_id <> $5
     RETURNING id`,
    [
      event.rows[0].id,
      type,
      JSON.stringify(payload),
      [booking.artist_profile_id, booking.venue_profile_id],
      actor.userId
    ]
  );

  if (notifications.rows.length) {
    await client.query(
      `INSERT INTO book.outbox_events (notification_id) SELECT unnest($1::uuid[])`,
      [notifications.rows.map((r) => r.id)]
    );
  }
}
