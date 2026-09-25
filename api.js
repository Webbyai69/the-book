/* ================================================================
   The Book — browser API client.

   Replaces load()/save() in app.js. The rest of the app still reads
   from one `state` object, so the render layer barely changes.

   Three rules this file exists to enforce:

   1. Each action calls its own endpoint. There is no "upload the whole
      state" call — the server decides what is permitted, not the client.
   2. A retry reuses the SAME idempotency key. A new key means a new
      action. Getting this backwards creates duplicate bookings.
   3. When the server is unreachable, the app shows a retryable error.
      It NEVER falls back to local demo bookings. A venue must never be
      shown a booking that does not exist on the server.
   ================================================================ */

(function (global) {
  "use strict";

  var API_BASE = global.THE_BOOK_API_BASE || "/api";

  /* ---------- session ----------
     accessToken comes from Supabase Auth in the browser. profileId is
     whichever of the user's profiles is currently selected — the real
     version of the prototype's Venue/Artist switch. */
  var session = { accessToken: null, profileId: null };

  /* Bumped on every profile switch. A response that comes back carrying
     an older epoch is discarded: without this, switching from venue to
     artist mid-request can render the previous profile's bookings into
     the new profile's screen. */
  var epoch = 0;

  function setSession(next) {
    if (next.profileId !== session.profileId) epoch += 1;
    session = { accessToken: next.accessToken, profileId: next.profileId };
    return epoch;
  }

  function currentEpoch() { return epoch; }

  /* ---------- errors ---------- */

  function ApiError(status, code, message, retryable) {
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.message = message;
    this.retryable = !!retryable;
  }
  ApiError.prototype = Object.create(Error.prototype);

  /* Conflicts that mean "your view is out of date" — the caller should
     refetch and re-render rather than retrying the same command. */
  var STALE_CODES = ["STALE_BOOKING", "ACTION_NOT_ALLOWED", "GIG_CALL_CLOSED", "GIG_CALL_FILLED"];

  function isStale(code) { return STALE_CODES.indexOf(code) !== -1; }

  /* ---------- idempotency ----------
     A key is minted once per user action and reused for every retry of
     that action. Keys are held in memory only: a page reload legitimately
     starts a new action. */

  var pendingKeys = {};

  function keyFor(actionId) {
    if (!pendingKeys[actionId]) {
      pendingKeys[actionId] = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    }
    return pendingKeys[actionId];
  }

  function clearKey(actionId) { delete pendingKeys[actionId]; }

  /* ---------- transport ---------- */

  function request(method, path, options) {
    options = options || {};
    var requestEpoch = epoch;

    var headers = { Accept: "application/json" };

    if (session.accessToken) headers.Authorization = "Bearer " + session.accessToken;
    if (session.profileId) headers["X-Profile-Id"] = session.profileId;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.body) headers["Content-Type"] = "application/json";

    var controller = global.AbortController ? new global.AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;

    return fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller ? controller.signal : undefined,
      credentials: "same-origin"
    }).then(function (response) {
      if (timer) clearTimeout(timer);

      /* The user switched profile while this was in flight. Its result
         belongs to a screen that is no longer on display. */
      if (requestEpoch !== epoch) {
        throw new ApiError(0, "SUPERSEDED", "Profile changed during request.", false);
      }

      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }

        if (response.ok) return payload;

        var err = (payload && payload.error) || {};

        /* 5xx and 429 are worth retrying with the same key. 4xx are not:
           the request itself is the problem. */
        var retryable = response.status >= 500 || response.status === 429;

        throw new ApiError(
          response.status,
          err.code || "HTTP_" + response.status,
          err.message || "The request could not be completed.",
          retryable
        );
      });
    }).catch(function (error) {
      if (timer) clearTimeout(timer);
      if (error instanceof ApiError) throw error;

      /* Network failure, DNS, timeout, offline. The outcome of the request
         is UNKNOWN — it may have reached the server. This is exactly why
         the same idempotency key must be reused on retry. */
      throw new ApiError(
        0,
        "NETWORK_UNAVAILABLE",
        "Could not reach The Book. Check your connection and try again.",
        true
      );
    });
  }

  /* A mutation wrapper: mints the key, keeps it for retries, releases it
     only once the action has definitively succeeded or definitively
     failed. An unknown outcome keeps the key so the retry can replay. */
  function mutate(actionId, method, path, body) {
    var key = keyFor(actionId);

    return request(method, path, { body: body, idempotencyKey: key })
      .then(function (result) {
        clearKey(actionId);
        return result;
      })
      .catch(function (error) {
        if (!error.retryable) clearKey(actionId);
        throw error;
      });
  }

  /* ---------- reads ---------- */

  /* One authorised call returns everything the shell needs. The server
     verifies the signed-in user belongs to profileId — a profile id in a
     header proves nothing on its own. */
  function bootstrap() {
    return request("GET", "/bootstrap?profileId=" + encodeURIComponent(session.profileId));
  }

  function discover(filters) {
    var params = [];
    if (filters.county) params.push("county=" + encodeURIComponent(filters.county));
    if (filters.actType) params.push("actType=" + encodeURIComponent(filters.actType));
    if (filters.genre) params.push("genre=" + encodeURIComponent(filters.genre));
    /* The prototype's date filter was never wired up. Availability is a
       server-side question now — the client cannot know who is free. */
    if (filters.date) params.push("date=" + encodeURIComponent(filters.date));
    return request("GET", "/artists" + (params.length ? "?" + params.join("&") : ""));
  }

  function gigCalls(filters) {
    filters = filters || {};
    var q = filters.county ? "?county=" + encodeURIComponent(filters.county) : "";
    return request("GET", "/gig-calls" + q);
  }

  function bookings() { return request("GET", "/bookings"); }
  function thread(bookingId) { return request("GET", "/bookings/" + bookingId + "/messages"); }
  function notifications() { return request("GET", "/notifications"); }

  /* ---------- mutations ----------
     Every command that changes a booking sends expectedVersion and
     expectedTermsRevision. The server rejects a stale view with 409
     rather than applying a change the user did not actually see. */

  function createBookingRequest(artistProfileId, eventDate, terms) {
    return mutate(
      "request:" + artistProfileId + ":" + eventDate,
      "POST",
      "/bookings",
      { artistProfileId: artistProfileId, eventDate: eventDate, terms: terms }
    );
  }

  function applyToGigCall(gigCallId, note) {
    return mutate(
      "apply:" + gigCallId,
      "POST",
      "/gig-calls/" + gigCallId + "/applications",
      { note: note }
    );
  }

  function makeOffer(booking, terms) {
    return mutate(
      "offer:" + booking.id + ":" + booking.version,
      "POST",
      "/bookings/" + booking.id + "/offer",
      {
        expectedVersion: booking.version,
        expectedTermsRevision: booking.termsRevision,
        terms: terms
      }
    );
  }

  function acceptBooking(booking) {
    return mutate(
      "accept:" + booking.id + ":" + booking.version,
      "POST",
      "/bookings/" + booking.id + "/accept",
      {
        expectedVersion: booking.version,
        expectedTermsRevision: booking.termsRevision
      }
    );
  }

  function transitionBooking(booking, action, reason) {
    return mutate(
      action + ":" + booking.id + ":" + booking.version,
      "POST",
      "/bookings/" + booking.id + "/transition",
      {
        action: action,
        reason: reason,
        expectedVersion: booking.version,
        expectedTermsRevision: booking.termsRevision
      }
    );
  }

  /* Confirmation is the one that will take money once the booking fee is
     live, so it is deliberately separate from the other transitions. */
  function confirmBooking(booking) {
    return mutate(
      "confirm:" + booking.id + ":" + booking.version,
      "POST",
      "/bookings/" + booking.id + "/confirm",
      {
        expectedVersion: booking.version,
        expectedTermsRevision: booking.termsRevision
      }
    );
  }

  function sendMessage(bookingId, text) {
    /* Keyed on content so a double-send of the same text replays rather
       than posting twice, but a genuine repeat ("ok" then "ok") still
       gets through because the key is released on success. */
    return mutate(
      "msg:" + bookingId + ":" + text.slice(0, 64),
      "POST",
      "/bookings/" + bookingId + "/messages",
      { text: text }
    );
  }

  function submitReview(booking, score, note) {
    return mutate(
      "review:" + booking.id,
      "POST",
      "/bookings/" + booking.id + "/reviews",
      { score: score, note: note }
    );
  }

  function updateProfile(patch) {
    return mutate("profile:" + session.profileId, "PATCH", "/profiles/" + session.profileId, patch);
  }

  function markNotificationRead(id) {
    return mutate("notif:" + id, "POST", "/notifications/" + id + "/read", {});
  }

  /* ---------- state adapter ----------
     Maps the server's shape onto the `state` object app.js already
     renders from, so renderHome/renderBookings/renderCal need no rewrite.

     Note what is NOT here: `role`. The prototype flipped state.role to
     act as the other side. Real profiles are switched by signing in as
     one you actually own, and the server enforces it. */
  function hydrate(state, payload) {
    state.onboarded = true;
    state.profileId = payload.profile.id;
    state.kind = payload.profile.kind;
    state.name = payload.profile.name;
    state.county = payload.profile.county;
    state.bio = payload.profile.bio || "";
    state.artists = payload.artists || [];
    state.gigcalls = payload.gigCalls || [];
    state.bookings = payload.bookings || [];
    state.threads = payload.threads || [];
    state.notifs = payload.notifications || [];
    return state;
  }

  /* Buttons are rendered from the server's allowedActions, never guessed
     from the role. This is what stops an artist being offered "Accept"
     on an application they submitted themselves. */
  function can(booking, action) {
    return !!booking.allowedActions && booking.allowedActions.indexOf(action) !== -1;
  }

  global.TheBookApi = {
    setSession: setSession,
    currentEpoch: currentEpoch,
    ApiError: ApiError,
    isStale: isStale,

    bootstrap: bootstrap,
    discover: discover,
    gigCalls: gigCalls,
    bookings: bookings,
    thread: thread,
    notifications: notifications,

    createBookingRequest: createBookingRequest,
    applyToGigCall: applyToGigCall,
    makeOffer: makeOffer,
    acceptBooking: acceptBooking,
    transitionBooking: transitionBooking,
    confirmBooking: confirmBooking,
    sendMessage: sendMessage,
    submitReview: submitReview,
    updateProfile: updateProfile,
    markNotificationRead: markNotificationRead,

    hydrate: hydrate,
    can: can
  };
})(typeof window !== "undefined" ? window : globalThis);
