(function () {
  "use strict";

  /* ================================================================
     The Book — client-side app engine.
     All state lives in one `state` object, persisted to localStorage.
     Replace load()/save() and the mutation points marked API: with
     server calls to connect a real backend — the UI reads only state.
     ================================================================ */

  var ICONS = {
    harp: '<svg viewBox="0 0 24 24"><path d="M5 21V5c0-1.6 1-2.6 2.5-2.6S10 3.4 10 5"/><path d="M5 21h11c2.2 0 3-1.4 3-3V3"/><path d="M8 6v12M11 6.5v11M14 7v10M16.5 7.5v9"/></svg>',
    fiddle: '<svg viewBox="0 0 24 24"><path d="M14 10l6-6M17 3l4 4"/><path d="M9 11c-3 0-5 2-5 4.5S6 20 8.5 20 13 18 13 15c0-2-1-4-4-4z"/><path d="M11 13l3-3"/></svg>',
    guitar: '<svg viewBox="0 0 24 24"><path d="M13 11l8-8M19 2l3 3"/><path d="M8 12c-2 0-4 1-4 3.5C4 18 6 20 8.5 20S13 18 13 15.5C13 13 11 12 8 12z"/><circle cx="8.7" cy="15.8" r="1.4"/></svg>',
    voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>',
    band: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/></svg>',
    dj: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="12" rx="2"/><circle cx="8" cy="13" r="3"/><circle cx="8" cy="13" r="0.6"/><path d="M15 10h4M15 13h4M15 16h2"/></svg>'
  };
  var GENRES = ["Rock", "Pop", "Country", "Jazz", "Indie", "Electronic", "Folk", "Trad"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  /* ================================================================
     Social links and clips.

     Rule: a pasted string never reaches an iframe src. Every URL is
     parsed, its host checked against a whitelist, its id extracted, and
     the embed URL rebuilt from our own template. Anything that does not
     match is rejected rather than rendered.
     ================================================================ */

  var MAX_LINKS = 6;
  var MAX_MEDIA = 4;

  var PLATFORM_ICONS = {
    facebook: '<svg viewBox="0 0 24 24"><path d="M15 3h-2.5A3.5 3.5 0 0 0 9 6.5V9H7v3h2v9h3v-9h2.5l.5-3H12V6.8c0-.5.3-.8.8-.8H15z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></svg>',
    youtube: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2l5 2.8-5 2.8z"/></svg>',
    spotify: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M7.5 9.6c3-.8 6.2-.5 8.8 1M8.2 12.6c2.4-.6 5-.4 7.1.8M9 15.4c1.8-.4 3.7-.3 5.3.6"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24"><path d="M14 4v9.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 4c.4 2.2 2 3.7 4.2 3.9"/></svg>',
    bandcamp: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 15l4-6 4 6z"/></svg>',
    soundcloud: '<svg viewBox="0 0 24 24"><path d="M4 16v-4M7 17V9M10 17V7.5M13 17V9"/><path d="M16 17h3.2a2.8 2.8 0 0 0 0-5.6c-.2 0-.4 0-.6.1A4.2 4.2 0 0 0 16 8.6V17z"/></svg>',
    website: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>'
  };

  /* Paths are rebuilt, not passed through: only these characters survive. */
  var SAFE_PATH = /^[A-Za-z0-9\/@._-]*$/;

  function pathOk(p) { return SAFE_PATH.test(p) && p.indexOf("..") === -1; }

  function idOk(re, v) { return typeof v === "string" && re.test(v); }

  var SOCIAL = {
    youtube: {
      label: "YouTube", hostHint: "youtube.com or youtu.be", canEmbed: true, isMedia: true,
      hostOk: function (h) { return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].indexOf(h) !== -1; },
      extract: function (u, h) {
        var id = null;
        var parts = u.pathname.split("/").filter(Boolean);
        if (h === "youtu.be") id = parts[0];
        else if (parts[0] === "watch") id = u.searchParams.get("v");
        else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") id = parts[1];
        if (!idOk(/^[A-Za-z0-9_-]{11}$/, id)) return { ok: false, error: "That does not contain a YouTube video id." };
        return {
          ok: true,
          url: "https://www.youtube.com/watch?v=" + id,
          embed: "https://www.youtube-nocookie.com/embed/" + id
        };
      }
    },
    spotify: {
      label: "Spotify", hostHint: "open.spotify.com", canEmbed: true, isMedia: true,
      hostOk: function (h) { return h === "open.spotify.com"; },
      extract: function (u) {
        var parts = u.pathname.split("/").filter(Boolean);
        /* Spotify prefixes shared links with a locale: /intl-de/track/... */
        if (parts[0] && (parts[0].length === 2 || /^intl-[a-z]{2}$/i.test(parts[0]))) parts.shift();
        var kinds = ["track", "album", "artist", "playlist", "episode", "show"];
        var kind = parts[0], id = parts[1];
        if (kinds.indexOf(kind) === -1) return { ok: false, error: "Use a Spotify track, album, artist or playlist link." };
        if (!idOk(/^[A-Za-z0-9]{22}$/, id)) return { ok: false, error: "That Spotify link has no id in it." };
        return {
          ok: true,
          url: "https://open.spotify.com/" + kind + "/" + id,
          embed: "https://open.spotify.com/embed/" + kind + "/" + id
        };
      }
    },
    soundcloud: {
      label: "SoundCloud", hostHint: "soundcloud.com", canEmbed: true, isMedia: true,
      hostOk: function (h) { return h === "soundcloud.com" || h === "www.soundcloud.com"; },
      extract: function (u) {
        var parts = u.pathname.split("/").filter(Boolean);
        if (!parts.length || parts.length > 3) return { ok: false, error: "Use a SoundCloud profile or track link." };
        for (var i = 0; i < parts.length; i++) {
          if (!idOk(/^[A-Za-z0-9_-]{1,80}$/, parts[i])) return { ok: false, error: "That SoundCloud link has unexpected characters." };
        }
        var canonical = "https://soundcloud.com/" + parts.join("/");
        /* A bare profile has nothing to play, so it embeds only as a track or set. */
        var embed = parts.length >= 2
          ? "https://w.soundcloud.com/player/?url=" + encodeURIComponent(canonical) + "&visual=false&show_comments=false"
          : null;
        return { ok: true, url: canonical, embed: embed };
      }
    },
    bandcamp: {
      /* Link only. A Bandcamp embed needs the numeric album/track id, which is
         not present in a public page URL -- it only appears in the page's own
         markup. Rebuilding an embed URL from the parts we have is not possible,
         and interpolating the pasted string is exactly what we do not do. */
      label: "Bandcamp", hostHint: "a bandcamp.com address", canEmbed: false, isMedia: false,
      hostOk: function (h) { return h === "bandcamp.com" || /\.bandcamp\.com$/.test(h); },
      extract: function (u, h) {
        if (!pathOk(u.pathname)) return { ok: false, error: "That Bandcamp link has unexpected characters." };
        return { ok: true, url: "https://" + h + u.pathname.replace(/\/$/, ""), embed: null };
      }
    },
    facebook: {
      /* Buttons, not embeds: the Facebook SDK carries tracking. */
      label: "Facebook", hostHint: "facebook.com", canEmbed: false, isMedia: false,
      hostOk: function (h) { return ["facebook.com", "www.facebook.com", "fb.com", "www.fb.com"].indexOf(h) !== -1; },
      extract: function (u) {
        if (!pathOk(u.pathname) || u.pathname === "/") return { ok: false, error: "Link to your Facebook page, not just facebook.com." };
        return { ok: true, url: "https://www.facebook.com" + u.pathname.replace(/\/$/, ""), embed: null };
      }
    },
    instagram: {
      label: "Instagram", hostHint: "instagram.com", canEmbed: false, isMedia: false,
      hostOk: function (h) { return ["instagram.com", "www.instagram.com"].indexOf(h) !== -1; },
      extract: function (u) {
        if (!pathOk(u.pathname) || u.pathname === "/") return { ok: false, error: "Link to your Instagram profile or a post." };
        return { ok: true, url: "https://www.instagram.com" + u.pathname.replace(/\/$/, ""), embed: null };
      }
    },
    tiktok: {
      label: "TikTok", hostHint: "tiktok.com", canEmbed: false, isMedia: false,
      hostOk: function (h) { return ["tiktok.com", "www.tiktok.com"].indexOf(h) !== -1; },
      extract: function (u) {
        if (!pathOk(u.pathname) || u.pathname === "/") return { ok: false, error: "Link to your TikTok profile or a video." };
        return { ok: true, url: "https://www.tiktok.com" + u.pathname.replace(/\/$/, ""), embed: null };
      }
    },
    website: {
      label: "Website", hostHint: "any https address", canEmbed: false, isMedia: false,
      hostOk: function (h) { return h.indexOf(".") > 0 && !/\s/.test(h); },
      extract: function (u, h) {
        if (!pathOk(u.pathname)) return { ok: false, error: "That address has unexpected characters in its path." };
        return { ok: true, url: "https://" + h + u.pathname.replace(/\/$/, ""), embed: null };
      }
    }
  };

  var VENUE_PLATFORMS = ["facebook", "instagram", "website"];
  function platformsFor(role) { return role === "venue" ? VENUE_PLATFORMS : Object.keys(SOCIAL); }

  /* Returns { ok:true, platform, url, embed } or { ok:false, error }. */
  function parseSocial(platform, raw) {
    var cfg = SOCIAL[platform];
    if (!cfg) return { ok: false, error: "Pick a platform first." };

    var s = String(raw == null ? "" : raw).trim();
    if (!s) return { ok: false, error: "Paste a link first." };
    if (s.length > 500) return { ok: false, error: "That link is too long." };

    /* Rejected before any parsing, so a crafted scheme never gets a second look. */
    if (/^[a-z0-9.+-]*\s*:/i.test(s) && !/^https?:\/\//i.test(s)) {
      return { ok: false, error: "Only https links are accepted." };
    }
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|\?|$)/i.test(s)) s = "https://" + s;
      else return { ok: false, error: "Use a full https:// link." };
    }

    var u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: "That is not a valid link." }; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Only https links are accepted." };

    var host = u.hostname.toLowerCase();
    if (!cfg.hostOk(host)) return { ok: false, error: cfg.label + " links must be on " + cfg.hostHint + "." };

    var out = cfg.extract(u, host);
    if (!out.ok) return out;
    if (out.url.length < 8 || out.url.length > 500) return { ok: false, error: "That link is not a usable length." };
    out.platform = platform;
    return out;
  }

  function linksOf(o) { return (o && o.links) || []; }
  function mediaOf(o) { return (o && o.media) || []; }

  /* A row of platform buttons. Every one opens in a new tab; none embeds. */
  function linksRowHtml(links) {
    if (!links || !links.length) return "";
    return '<div class="links-row">' + links.map(function (l) {
      var cfg = SOCIAL[l.platform];
      if (!cfg) return "";
      return '<a class="link-chip" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer"'
        + ' title="' + esc(cfg.label) + '" aria-label="' + esc(cfg.label) + '">'
        + (PLATFORM_ICONS[l.platform] || "") + "<span>" + esc(cfg.label) + "</span></a>";
    }).join("") + "</div>";
  }

  /* Embeds are built from our own templates. Anything without a rebuilt embed
     URL falls back to a button. */
  function mediaHtml(media) {
    if (!media || !media.length) return "";
    return '<div class="clips">' + media.slice(0, MAX_MEDIA).map(function (m, i) {
      var parsed = parseSocial(m.platform, m.source);
      if (!parsed.ok) return "";
      var title = m.title ? '<p class="clip-title">' + esc(m.title) + "</p>" : "";
      if (!parsed.embed) {
        return '<div class="clip">' + title
          + '<a class="btn btn-line" href="' + esc(parsed.url) + '" target="_blank" rel="noopener noreferrer">Open on '
          + esc(SOCIAL[m.platform].label) + "</a></div>";
      }
      return '<div class="clip clip-' + esc(m.platform) + (i === 0 ? " clip-first" : "") + '">' + title
        + '<iframe src="' + esc(parsed.embed) + '"'
        + ' title="' + esc(m.title || SOCIAL[m.platform].label + " clip") + '"'
        + ' loading="lazy" allowfullscreen'
        + ' referrerpolicy="no-referrer"'
        + ' sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></div>';
    }).join("") + "</div>";
  }

  var $ = function (id) { return document.getElementById(id); };
  function clampInt(v, fb) { var n = parseInt(v, 10); return isNaN(n) ? fb : n; }
  function esc(x) { return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function rel(days) { var d = new Date(); d.setDate(d.getDate() + days); return iso(d); }
  function fmt(isoStr) {
    if (!isoStr) return "Date to be set";
    var d = new Date(isoStr + "T12:00:00");
    return d.toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" });
  }
  function fmtLong(isoStr) {
    var d = new Date(isoStr + "T12:00:00");
    return d.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
  }
  function todayISO() { return iso(new Date()); }

  /* ---------- seed data (fictional, from the product concept; Plamasers and Hannah's are real onboarded names) ---------- */
  function seedState() {
    var artists = [
      { id: 1, name: "The Midnight Sons", type: "Band", county: "Meath", genres: ["Rock", "Pop", "Indie"], icon: "band", feeMin: 500, feeMax: 800, rating: 4.9, gigs: 37, exp: "8 years, 300+ gigs", busy: [rel(7), rel(14)], bio: "Four-piece live band specialising in classic rock, modern pop and indie favourites. Available for pubs, bars, weddings and private events. PA carried, soundcheck required.",
        links: [
          { platform: "youtube", url: "https://www.youtube.com/watch?v=Rk7VmQ3pL2s" },
          { platform: "facebook", url: "https://www.facebook.com/themidnightsonsband" },
          { platform: "instagram", url: "https://www.instagram.com/themidnightsons" },
          { platform: "website", url: "https://themidnightsons.ie" }
        ],
        media: [
          { kind: "link", platform: "youtube", source: "https://www.youtube.com/watch?v=Rk7VmQ3pL2s", title: "Live at The Harbour Bar — full set opener" },
          { kind: "link", platform: "youtube", source: "https://www.youtube.com/watch?v=Nb4xT8yUw1c", title: "Wedding reception, second set" }
        ] },
      { id: 2, name: "The Riverside Boys", type: "Band", county: "Meath", genres: ["Rock", "Country"], icon: "guitar", feeMin: 450, feeMax: 700, rating: 4.8, gigs: 52, exp: "10 years", busy: [], bio: "High-energy covers band mixing country rock with singalong classics. Regulars on the pub and wedding circuit." },
      { id: 3, name: "Electric Avenue", type: "Band", county: "Dublin", genres: ["Pop", "Electronic"], icon: "band", feeMin: 600, feeMax: 900, rating: 4.7, gigs: 44, exp: "6 years", busy: [rel(9)], bio: "Pop and electronic party band with full light show. Built for big rooms, clubs and corporate events." },
      { id: 4, name: "The Sessions", type: "Duo or trio", county: "Clare", genres: ["Folk", "Trad"], icon: "fiddle", feeMin: 300, feeMax: 450, rating: 4.9, gigs: 61, exp: "12 years", busy: [rel(21)], bio: "Fiddle, guitar and vocals — folk and trad sets that build from slow airs to flat-out reels. Perfect for pubs and intimate rooms.",
        links: [
          { platform: "youtube", url: "https://www.youtube.com/watch?v=Zq9dK5mHv7t" },
          { platform: "facebook", url: "https://www.facebook.com/thesessionsclare" }
        ],
        media: [
          { kind: "link", platform: "youtube", source: "https://www.youtube.com/watch?v=Zq9dK5mHv7t", title: "Reels set, Ennis" }
        ] },
      { id: 5, name: "The Plámásers", type: "Band", county: "Cork", genres: ["Folk", "Trad"], icon: "band", feeMin: null, feeMax: null, rating: null, gigs: null, exp: "One of the first acts on the roster", busy: [rel(9)], bio: "Trad and ballad group from Cork and one of the first acts on the roster. Full profile, set list and rates to be added from the band. Find them on Facebook at theplamasersmusic.",
        links: [
          { platform: "facebook", url: "https://www.facebook.com/theplamasersmusic" }
        ] },
      { id: 6, name: "Cara Delaney", type: "Solo", county: "Galway", genres: ["Folk", "Indie"], icon: "voice", feeMin: 250, feeMax: 400, rating: 5.0, gigs: 33, exp: "7 years", busy: [], bio: "Solo singer-songwriter with loop pedal — acoustic folk and indie covers plus originals. Quiet rooms and dinner service a speciality.",
        links: [
          { platform: "youtube", url: "https://www.youtube.com/watch?v=Wm2pT6bXq4h" },
          { platform: "spotify", url: "https://open.spotify.com/artist/3n7XQ1kZpR8vYbLmT2sWdC" },
          { platform: "instagram", url: "https://www.instagram.com/caradelaneymusic" }
        ],
        media: [
          { kind: "link", platform: "youtube", source: "https://www.youtube.com/watch?v=Wm2pT6bXq4h", title: "Loop pedal set, live" },
          { kind: "link", platform: "spotify", source: "https://open.spotify.com/track/4mQ2vC8nJ1yRtXpZ6bLsDe", title: "Originals — studio single" }
        ] },
      { id: 7, name: "Jack and Rosie", type: "Duo or trio", county: "Cork", genres: ["Pop", "Country"], icon: "guitar", feeMin: 350, feeMax: 500, rating: 4.8, gigs: 48, exp: "9 years", busy: [rel(4)], bio: "Acoustic duo covering pop, country and requests. Two sets, easy load-in, own PA." },
      { id: 8, name: "DJ Member", type: "DJ", county: "Dublin", genres: ["Electronic", "Pop"], icon: "dj", feeMin: 300, feeMax: 500, rating: 4.6, gigs: 57, exp: "11 years", busy: [rel(2)], bio: "Club and late-bar DJ — chart, house and throwback sets. Reads the room and keeps the floor moving until close." },
      { id: 9, name: "The Long Acre Selector", type: "DJ", county: "Dublin", genres: ["Folk", "Rock"], icon: "dj", feeMin: 220, feeMax: 350, rating: 4.7, gigs: 38, exp: "7 years", busy: [], bio: "Vinyl DJ spinning Irish ballads, folk revival and classic rock records. Ideal between live sets or for themed nights." },
      { id: 10, name: "Midlands Jazz Collective", type: "Band", county: "Meath", genres: ["Jazz"], icon: "band", feeMin: 550, feeMax: 850, rating: 4.9, gigs: 29, exp: "15 years", busy: [rel(14)], bio: "Five-piece jazz outfit for hotels, weddings and supper clubs. Standards, swing and bossa, dinner-volume friendly." }
    ];
    var gigcalls = [
      { id: 100, venue: "The Harbour Bar", county: "Meath", dateISO: rel(16), slot: "9:00 pm to 11:00 pm", budget: 650, styles: ["Rock", "Pop"], bio: "Busy pub, capacity 250, regular entertainment Friday and Saturday. Stage, house PA and sound engineer. Preferred genres rock, pop and country." },
      { id: 101, venue: "Hannah's (Griffins) Bar", county: "Cork", dateISO: rel(12), slot: "Evening live music", budget: null, styles: ["Folk", "Trad"], bio: "Buzzing country local at Skenakilla Cross, Co. Cork with regular live music and a loyal crowd. One of the first venues on the roster." },
      { id: 102, venue: "The Grand Hotel", county: "Dublin", dateISO: rel(23), slot: "Wedding drinks reception", budget: 450, styles: ["Jazz", "Folk"], bio: "Wedding party seeking jazz or acoustic folk for a two-hour drinks reception. Quiet-volume set." },
      { id: 103, venue: "Club Eile", county: "Dublin", dateISO: rel(30), slot: "11:00 pm to 2:00 am", budget: 400, styles: ["Electronic", "Pop"], bio: "Late venue looking for a resident-style DJ, Saturdays. Full booth and monitors in place." }
    ];
    var bookings = [
      { id: 1, artistId: 1, artistName: "The Midnight Sons", venueName: "The Harbour Bar", dateISO: rel(-7), slot: "9:00 pm to 11:00 pm", fee: 650, dep: 150, status: "ok", icon: "band" },
      { id: 2, artistId: 2, artistName: "The Riverside Boys", venueName: "The Harbour Bar", dateISO: rel(10), slot: "9:30 pm to 11:30 pm", fee: 550, dep: 100, status: "ok", icon: "guitar" },
      { id: 3, artistId: 6, artistName: "Cara Delaney", venueName: "The Grand Hotel", dateISO: rel(17), slot: "6:00 pm to 8:00 pm", fee: 300, dep: 0, status: "pend", icon: "voice" }
    ];
    var threads = [
      { id: 1, name: "The Midnight Sons", msgs: [
        { from: "venue", t: "Can you bring your own PA?", when: "Tue 14:02" },
        { from: "artist", t: "Yes, no problem.", when: "Tue 14:19" },
        { from: "venue", t: "Perfect. Soundcheck at 8?", when: "Tue 14:31" },
        { from: "artist", t: "Suits us. See you then.", when: "Tue 15:05" } ] },
      { id: 2, name: "The Riverside Boys", msgs: [
        { from: "artist", t: "Confirming the 9:30 start. We will arrive for 8 to set up.", when: "Mon 10:12" } ] }
    ];
    return {
      ver: 1,
      onboarded: false,
      role: "venue",
      name: "",
      county: "Meath",
      bio: "",
      links: [],
      media: [],
      nextId: 500,
      artists: artists,
      gigcalls: gigcalls,
      bookings: bookings,
      threads: threads,
      notifs: [
        { id: 1, forRole: "venue", text: "Cara Delaney was sent your booking request and will reply here.", tab: "bookings", ts: "Earlier", read: true }
      ]
    };
  }

  var KEY = "thebook-v1";
  var state;
  /* Older saved state predates links and media. Fill the fields in rather than
     bumping ver, which would throw away the user's demo data. */
  function normalise(st) {
    if (!st) return st;
    if (!Array.isArray(st.links)) st.links = [];
    if (!Array.isArray(st.media)) st.media = [];
    (st.artists || []).forEach(function (a) {
      if (!Array.isArray(a.links)) a.links = [];
      if (!Array.isArray(a.media)) a.media = [];
    });
    return st;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var st = JSON.parse(raw); if (st && st.ver === 1) return normalise(st); }
    } catch (e) {}
    return normalise(seedState());
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  state = load();
  function nid() { state.nextId += 1; return state.nextId; }

  /* ---------- toast ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("on"); }, 3000);
  }

  /* ---------- notifications ---------- */
  function notify(forRole, text, tab, extra) {
    var n = { id: nid(), forRole: forRole, text: text, tab: tab || "bookings", ts: new Date().toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" }), read: false };
    if (extra) { n.suggestFor = extra.suggestFor; n.dateISO = extra.dateISO; }
    state.notifs.unshift(n);
    save();
    renderBell();
  }
  function myNotifs() { return state.notifs.filter(function (n) { return n.forRole === state.role; }); }
  function renderBell() {
    var unread = myNotifs().filter(function (n) { return !n.read; }).length;
    var b = $("bellBadge");
    b.textContent = unread;
    b.classList.toggle("zero", unread === 0);
  }
  function renderDrawer() {
    var host = $("notifList");
    host.innerHTML = "";
    var list = myNotifs();
    if (!list.length) { host.innerHTML = '<p class="drawer-empty">Nothing yet. Booking activity for your role lands here.</p>'; return; }
    list.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "notif" + (n.read ? "" : " unread");
      b.innerHTML = esc(n.text) + "<small>" + esc(n.ts) + "</small>";
      b.addEventListener("click", function () {
        n.read = true;
        save();
        renderBell();
        $("drawer").classList.remove("on");
        showTab(n.tab);
        if (n.suggestFor !== undefined) {
          var declined = state.artists.filter(function (a) { return a.id === n.suggestFor; })[0];
          if (declined) suggestAlternative(declined, n.dateISO);
        }
      });
      host.appendChild(b);
    });
  }
  $("bellBtn").addEventListener("click", function () { renderDrawer(); $("drawer").classList.toggle("on"); });
  $("drawerClose").addEventListener("click", function () { $("drawer").classList.remove("on"); });

  /* ---------- tabs ---------- */
  var tabs = document.querySelectorAll(".tab");
  function showTab(view) {
    tabs.forEach(function (x) { x.classList.toggle("on", x.dataset.view === view); });
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("on"); });
    $("view-" + view).classList.add("on");
    if (view === "home") renderHome();
    window.scrollTo({ top: 0 });
  }
  tabs.forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.view); }); });

  /* ---------- role + identity ---------- */
  function renderWho() {
    var chip = $("whoChip");
    if (state.name) chip.innerHTML = "Acting as <b>" + esc(state.name) + "</b>";
    else chip.textContent = "";
  }
  function setRole(r) {
    state.role = r;
    save();
    $("roleVenue").classList.toggle("on", r === "venue");
    $("roleArtist").classList.toggle("on", r === "artist");
    if (r === "venue") {
      $("heroTitle").textContent = "Find your next act";
      $("heroLede").textContent = "Search local bands, solo acts, duos and DJs by date, county, act type and genre.";
      $("listTitle").textContent = "Acts available near you";
      $("addBtn").textContent = "Post a Gig Call";
      $("bkTitle").textContent = "Your venue bookings";
      $("homeLede").textContent = "The Book connects venues with local bands, musicians and DJs — discovery, availability, booking and gig management in one place.";
      $("homeRecTitle").textContent = "Recommended for you";
    } else {
      $("heroTitle").textContent = "Find your next gig";
      $("heroLede").textContent = "Venues across Ireland are looking for live acts. Browse open gig calls and apply.";
      $("listTitle").textContent = "Open gig calls from venues";
      $("addBtn").textContent = "Create Artist Profile";
      $("bkTitle").textContent = "Your gigs";
      $("homeLede").textContent = "Get discovered, fill your calendar and manage your gigs — profile, availability, requests and payments context in one place.";
      $("homeRecTitle").textContent = "Open gig calls";
    }
    renderChips();
    renderGrid();
    renderStats();
    renderBookings();
    renderBell();
    renderCal();
    renderHome();
    renderProfile();
  }
  $("roleVenue").addEventListener("click", function () { setRole("venue"); });
  $("roleArtist").addEventListener("click", function () { setRole("artist"); });

  /* ---------- onboarding ---------- */
  var onbRole = "venue";
  document.querySelectorAll(".onb-role").forEach(function (b) {
    b.addEventListener("click", function () {
      onbRole = b.dataset.r;
      document.querySelectorAll(".onb-role").forEach(function (x) { x.classList.toggle("on", x === b); });
    });
  });
  $("onbForm").addEventListener("submit", function (e) {
    e.preventDefault();
    state.name = $("onbName").value.trim();
    state.county = $("onbCounty").value;
    state.onboarded = true;
    save();
    $("onbBg").classList.remove("on");
    renderWho();
    setRole(onbRole);
    toast("You are in. Use the role switch any time to act as the other side of a booking.");
  });

  /* ---------- home ---------- */
  function renderHome() {
    var rec = $("homeRec");
    rec.innerHTML = "";
    if (state.role === "venue") {
      state.artists.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); }).slice(0, 3)
        .forEach(function (a) { rec.appendChild(artistCard(a)); });
    } else {
      state.gigcalls.slice(0, 3).forEach(function (g) { rec.appendChild(gigCard(g)); });
    }
    var up = $("homeUpcoming");
    up.innerHTML = "";
    var upcoming = state.bookings.filter(function (b) { return b.status === "ok" && b.dateISO >= todayISO(); })
      .sort(function (a, b) { return a.dateISO < b.dateISO ? -1 : 1; }).slice(0, 4);
    if (!upcoming.length) { up.innerHTML = '<p style="color:var(--faint);">No confirmed gigs coming up yet.</p>'; return; }
    upcoming.forEach(function (b) {
      var row = document.createElement("div");
      row.className = "brow";
      row.style.gridTemplateColumns = "44px 1fr auto";
      row.innerHTML =
        '<div class="ic">' + ICONS[b.icon] + "</div>" +
        '<div class="who">' + esc(state.role === "venue" ? b.artistName : b.venueName) + "<small>" + fmt(b.dateISO) + " &middot; " + esc(b.slot) + "</small></div>" +
        '<div class="amt">' + (b.fee ? "&euro;" + b.fee : "POA") + "</div>";
      up.appendChild(row);
    });
  }

  /* ---------- filter chips (genres) ---------- */
  var activeStyle = "";
  function renderChips() {
    var host = $("chips");
    host.innerHTML = "";
    var all = document.createElement("button");
    all.type = "button";
    all.className = "chip" + (activeStyle === "" ? " on" : "");
    all.textContent = "All genres";
    all.addEventListener("click", function () { activeStyle = ""; renderChips(); renderGrid(); });
    host.appendChild(all);
    GENRES.forEach(function (st) {
      var c = document.createElement("button");
      c.type = "button";
      c.className = "chip" + (activeStyle === st ? " on" : "");
      c.textContent = st;
      c.addEventListener("click", function () { activeStyle = st; renderChips(); renderGrid(); });
      host.appendChild(c);
    });
  }

  /* ---------- discover ---------- */
  var starSvg = '<svg viewBox="0 0 24 24"><polygon points="12 2 15 9 22 9.5 16.5 14.5 18.5 22 12 17.8 5.5 22 7.5 14.5 2 9.5 9 9"/></svg>';

  function feeRange(a) {
    if (!a.feeMin) return '<span class="fee">POA <span>rates on request</span></span>';
    return '<span class="fee">&euro;' + a.feeMin + "&ndash;&euro;" + a.feeMax + " <span>typical booking</span></span>";
  }

  function renderGrid() {
    var host = $("resultGrid");
    host.innerHTML = "";
    var county = $("fCounty").value;
    var type = $("fType") ? $("fType").value : "";
    if (state.role === "venue") {
      state.artists.filter(function (a) {
        if (county && a.county !== county) return false;
        if (type && a.type !== type) return false;
        if (activeStyle && a.genres.indexOf(activeStyle) === -1) return false;
        return true;
      }).forEach(function (a) { host.appendChild(artistCard(a)); });
      if (!host.children.length) host.innerHTML = '<p style="color:var(--faint);grid-column:1/-1;padding:30px 0;">No acts match those filters yet. Try widening the search.</p>';
    } else {
      state.gigcalls.filter(function (g) {
        if (county && g.county !== county) return false;
        if (activeStyle && g.styles.indexOf(activeStyle) === -1) return false;
        return true;
      }).forEach(function (g) { host.appendChild(gigCard(g)); });
      if (!host.children.length) host.innerHTML = '<p style="color:var(--faint);grid-column:1/-1;padding:30px 0;">No gig calls match those filters yet. Try widening the search.</p>';
    }
  }

  function artistCard(a) {
    var el = document.createElement("div");
    el.className = "card";
    var rateHtml = a.rating
      ? '<span class="rate">' + starSvg + a.rating.toFixed(1) + ' <span class="n">(' + a.gigs + ")</span></span>"
      : '<span class="rate"><span class="n">New on the roster</span></span>';
    /* The whole point is that a publican can hear the act before opening
       anything, so the card says so up front. */
    var hasClips = mediaOf(a).length > 0;
    var listen = hasClips
      ? '<button class="listen" type="button" aria-label="Listen to ' + esc(a.name) + '">&#9654; Listen</button>'
      : "";
    el.innerHTML =
      '<div class="card-art">' + ICONS[a.icon] + listen + "</div>" +
      '<div class="card-body">' +
        '<div class="card-top"><div><p class="card-name">' + esc(a.name) + '</p><p class="card-loc">' + esc(a.type) + " &middot; Co. " + esc(a.county) + (a.exp ? " &middot; " + esc(a.exp) : "") + "</p></div>" +
        rateHtml + "</div>" +
        '<div class="tags">' + a.genres.map(function (st) { return '<span class="tag">' + esc(st) + "</span>"; }).join("") + "</div>" +
        '<div class="card-foot">' + feeRange(a) +
        '<button class="btn btn-gold" type="button">View</button></div>' +
      "</div>";
    el.querySelector(".btn").addEventListener("click", function () { openModal(a); });
    if (hasClips) el.querySelector(".listen").addEventListener("click", function () { openModal(a); });
    return el;
  }

  function gigCard(g) {
    var el = document.createElement("div");
    el.className = "card";
    el.innerHTML =
      '<div class="card-art">' + ICONS.band + "</div>" +
      '<div class="card-body">' +
        '<div class="card-top"><div><p class="card-name">' + esc(g.venue) + '</p><p class="card-loc">Co. ' + esc(g.county) + " &middot; " + fmt(g.dateISO) + "</p></div></div>" +
        '<p class="card-loc">' + esc(g.bio) + "</p>" +
        '<div class="tags">' + g.styles.map(function (st) { return '<span class="tag">' + esc(st) + "</span>"; }).join("") + "</div>" +
        '<div class="card-foot">' + (g.budget ? '<span class="fee">&euro;' + g.budget + " <span>budget</span></span>" : '<span class="fee">POA <span>budget on request</span></span>') +
        '<button class="btn btn-gold" type="button">Apply</button></div>' +
      "</div>";
    el.querySelector(".btn").addEventListener("click", function () {
      /* API: create application */
      var me = state.name || "Your act";
      state.bookings.unshift({
        id: nid(), artistId: -1, artistName: me, venueName: g.venue,
        dateISO: g.dateISO, slot: g.slot, fee: g.budget, dep: 0, status: "pend", icon: "band"
      });
      ensureThread(g.venue).msgs.push({ from: "artist", t: "Application for your gig on " + fmt(g.dateISO) + " (" + g.slot + "). We would love to play.", when: "Now" });
      notify("venue", me + " applied for your gig call at " + g.venue + " on " + fmt(g.dateISO) + ".", "bookings");
      save();
      renderBookings(); renderStats(); renderCal(); renderHome();
      toast("Application sent to " + g.venue + ". Track it under Bookings.");
    });
    return el;
  }

  $("searchForm").addEventListener("submit", function (e) { e.preventDefault(); renderGrid(); showTab("discover"); });
  $("fCounty").addEventListener("change", renderGrid);
  if ($("fType")) $("fType").addEventListener("change", renderGrid);
  $("fStyle").addEventListener("change", function () { activeStyle = this.value; renderChips(); renderGrid(); });

  /* ---------- availability ---------- */
  function isBusy(artist, isoStr) {
    if (!artist || !isoStr) return false;
    if ((artist.busy || []).indexOf(isoStr) !== -1) return true;
    return state.bookings.some(function (b) { return b.artistId === artist.id && b.status === "ok" && b.dateISO === isoStr; });
  }

  /* ---------- booking modal ---------- */
  var currentArtist = null;
  function openModal(a) {
    currentArtist = a;
    $("mTitle").textContent = a.name;
    $("mSub").textContent = a.rating
      ? a.type + " · Co. " + a.county + " · " + a.rating.toFixed(1) + " rating · " + a.gigs + " gigs through The Book"
      : a.type + " · Co. " + a.county + " · new on the roster";
    $("mBio").textContent = a.bio;
    $("mTags").innerHTML = a.genres.map(function (st) { return '<span class="tag">' + esc(st) + "</span>"; }).join("");
    if ($("mLinks")) $("mLinks").innerHTML = linksRowHtml(linksOf(a));
    if ($("mMedia")) $("mMedia").innerHTML = mediaHtml(mediaOf(a));
    $("bFee").value = a.feeMin || "";
    $("bAvail").textContent = "";
    $("modalBg").classList.add("on");
  }
  function closeModal() { $("modalBg").classList.remove("on"); }
  $("mClose").addEventListener("click", closeModal);
  $("modalBg").addEventListener("click", function (e) { if (e.target === this) closeModal(); });

  $("bDate").addEventListener("change", function () {
    if (!currentArtist) return;
    var hint = $("bAvail");
    if (!this.value) { hint.textContent = ""; return; }
    if (isBusy(currentArtist, this.value)) {
      hint.textContent = "Their calendar shows this date as booked. You can still send the request, or pick another date.";
      hint.style.color = "var(--pend)";
    } else {
      hint.textContent = "Their calendar shows this date as free.";
      hint.style.color = "var(--ok)";
    }
  });

  function fmtTime(t) {
    if (!t) return "";
    var parts = t.split(":");
    var h = parseInt(parts[0], 10);
    var suffix = h >= 12 ? "pm" : "am";
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + ":" + parts[1] + " " + suffix;
  }

  $("bookForm").addEventListener("submit", function (e) {
    e.preventDefault();
    /* API: create booking request */
    var d = $("bDate").value;
    var slot = fmtTime($("bStart").value) + " to " + fmtTime($("bEnd").value);
    var note = $("bNote").value.trim();
    var me = state.name || "Your venue";
    var b = {
      id: nid(), artistId: currentArtist.id, artistName: currentArtist.name, venueName: me,
      dateISO: d, slot: slot, fee: clampInt($("bFee").value, currentArtist.feeMin || 0), dep: 0,
      status: "pend", icon: currentArtist.icon
    };
    state.bookings.unshift(b);
    ensureThread(currentArtist.name).msgs.push({ from: "venue", t: note || ("Booking request for " + fmt(d) + ", " + slot + "."), when: "Now" });
    notify("artist", me + " requested " + currentArtist.name + " for " + fmt(d) + ", " + slot + ". Accept or decline under Bookings.", "bookings");
    save();
    closeModal();
    renderBookings(); renderStats(); renderCal(); renderHome();
    toast("Request sent to " + currentArtist.name + ". Switch to the Artist view to respond as the act, or wait for their reply.");
  });

  /* ---------- finalize (price, deposit, times) ---------- */
  var finTarget = null;
  function updateBal() {
    var fee = clampInt($("finFee").value, 0);
    var dep = clampInt($("finDep").value, 0);
    $("finBal").textContent = "Balance on the night: €" + Math.max(0, fee - dep);
  }
  $("finFee").addEventListener("input", updateBal);
  $("finDep").addEventListener("input", updateBal);
  function openFinalize(b) {
    finTarget = b;
    $("finSub").textContent = b.artistName + " · " + fmt(b.dateISO) + " · " + b.slot;
    $("finFee").value = b.fee || "";
    $("finDep").value = b.dep || 0;
    updateBal();
    $("finBg").classList.add("on");
  }
  $("finClose").addEventListener("click", function () { $("finBg").classList.remove("on"); });
  $("finBg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("finForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!finTarget) return;
    /* API: confirm booking */
    finTarget.fee = clampInt($("finFee").value, finTarget.fee);
    finTarget.dep = clampInt($("finDep").value, 0);
    finTarget.status = "ok";
    notify("artist", "Booking confirmed: " + finTarget.venueName + ", " + fmt(finTarget.dateISO) + ", €" + finTarget.fee + " (deposit €" + finTarget.dep + "). Arrival " + fmtTime($("finArr").value) + ", soundcheck " + fmtTime($("finSc").value) + ".", "calendar");
    save();
    $("finBg").classList.remove("on");
    renderBookings(); renderStats(); renderCal(); renderHome();
    toast("Booking confirmed with " + finTarget.artistName + ". It is locked in both calendars.");
  });

  /* ---------- suggestion on decline ---------- */
  var sugArtist = null, sugDate = null;
  function suggestAlternative(declined, dateISO) {
    var alt = state.artists.filter(function (a) {
      if (a.id === declined.id) return false;
      if (dateISO && isBusy(a, dateISO)) return false;
      var genreMatch = a.genres.some(function (st) { return declined.genres.indexOf(st) !== -1; });
      return genreMatch || a.type === declined.type;
    })[0];
    if (!alt) return;
    sugArtist = alt;
    sugDate = dateISO;
    $("sugSub").textContent = declined.name + " declined your request" + (dateISO ? " for " + fmtLong(dateISO) : "") + ". Based on genre, act type and availability, here is an alternative.";
    $("sugCard").innerHTML =
      '<div class="brow" style="grid-template-columns:52px 1fr auto;">' +
        '<div class="ic">' + ICONS[alt.icon] + "</div>" +
        '<div class="who">' + esc(alt.name) + "<small>" + esc(alt.type) + " &middot; Co. " + esc(alt.county) + " &middot; " + alt.genres.join(", ") + " &middot; free on this date</small></div>" +
        '<div class="amt">' + (alt.feeMin ? "&euro;" + alt.feeMin + "&ndash;" + alt.feeMax : "POA") + "</div>" +
      "</div>";
    $("sugBg").classList.add("on");
  }
  $("sugClose").addEventListener("click", function () { $("sugBg").classList.remove("on"); });
  $("sugNo").addEventListener("click", function () { $("sugBg").classList.remove("on"); });
  $("sugBg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("sugBook").addEventListener("click", function () {
    $("sugBg").classList.remove("on");
    if (!sugArtist) return;
    openModal(sugArtist);
    if (sugDate) { $("bDate").value = sugDate; $("bDate").dispatchEvent(new Event("change")); }
  });

  /* ---------- bookings: grouped ---------- */
  function pillFor(st) {
    if (st === "ok") return '<span class="pill ok">Confirmed</span>';
    if (st === "pend") return '<span class="pill pend">Pending</span>';
    if (st === "acc") return '<span class="pill pend" style="color:var(--gold-bright);background:rgba(228,192,92,0.12);">Accepted</span>';
    return '<span class="pill bad">Cancelled</span>';
  }

  function bookingRow(b, group) {
    var row = document.createElement("div");
    row.className = "brow";
    var acts = "";
    if (state.role === "artist" && b.status === "pend") {
      acts = '<button class="btn btn-gold" data-a="acc" type="button">Accept</button>' +
             '<button class="btn btn-line" data-a="bad" type="button">Decline</button>';
    } else if (state.role === "venue" && b.status === "acc") {
      acts = '<button class="btn btn-gold" data-a="fin" type="button">Finalize Details</button>';
    } else if (state.role === "venue" && b.status === "pend") {
      acts = '<button class="btn btn-line" data-a="bad" type="button">Withdraw</button>';
    }
    if (group === "done") {
      acts = b.rated
        ? '<span class="rated">Rated ' + b.rated + ' of 5</span>'
        : '<button class="btn btn-gold" data-a="rate" type="button">Rate This Gig</button>';
    }
    acts += '<button class="btn btn-line" data-a="msg" type="button">Message</button>';
    var feeTxt = b.fee ? "&euro;" + b.fee + (b.dep ? ' <span style="font-size:0.68rem;color:var(--faint);">dep &euro;' + b.dep + "</span>" : "") : "POA";
    row.innerHTML =
      '<div class="ic">' + ICONS[b.icon] + "</div>" +
      '<div class="who">' + esc(state.role === "venue" ? b.artistName : b.venueName) + "<small>" + esc(b.slot) + "</small></div>" +
      '<div class="when">' + fmt(b.dateISO) + "</div>" +
      '<div class="amt">' + feeTxt + "</div>" +
      '<div class="acts">' + (group === "done" ? "" : pillFor(b.status)) + acts + "</div>";
    row.querySelectorAll("[data-a]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var a = btn.dataset.a;
        if (a === "fin") { openFinalize(b); return; }
        if (a === "msg") { openChat(state.role === "venue" ? b.artistName : b.venueName); return; }
        if (a === "rate") { openReview(b); return; }
        /* API: update booking status */
        b.status = a;
        if (a === "acc") {
          notify("venue", b.artistName + " accepted your request for " + fmt(b.dateISO) + ". Finalize price and details to confirm.", "bookings");
          toast("Request accepted. The venue has been notified to finalize price and details.");
        } else if (a === "bad" && state.role === "artist") {
          var declinedArtist = state.artists.filter(function (x) { return x.id === b.artistId; })[0];
          notify("venue", b.artistName + " declined your request for " + fmt(b.dateISO) + ". Tap for a similar act free that night.", "bookings",
                 declinedArtist ? { suggestFor: declinedArtist.id, dateISO: b.dateISO } : null);
          toast("Request declined. The venue will be offered a similar act with a free slot.");
        } else {
          toast("Booking withdrawn.");
        }
        save();
        renderBookings(); renderStats(); renderCal(); renderBell(); renderHome();
      });
    });
    return row;
  }

  function renderBookings() {
    var host = $("bookingList");
    host.innerHTML = "";
    var t = todayISO();
    var groups = [
      { key: "pending", title: "Pending", sub: "Waiting for a response", items: state.bookings.filter(function (b) { return b.status === "pend" || b.status === "acc"; }) },
      { key: "up", title: "Upcoming", sub: "Confirmed future gigs", items: state.bookings.filter(function (b) { return b.status === "ok" && b.dateISO >= t; }) },
      { key: "done", title: "Completed", sub: "Previous gigs", items: state.bookings.filter(function (b) { return b.status === "ok" && b.dateISO < t; }) },
      { key: "cancelled", title: "Cancelled", sub: "Declined or withdrawn", items: state.bookings.filter(function (b) { return b.status === "bad"; }) }
    ];
    var any = false;
    groups.forEach(function (g) {
      if (!g.items.length) return;
      any = true;
      var h = document.createElement("div");
      h.className = "bgroup";
      h.innerHTML = esc(g.title) + "<span>" + esc(g.sub) + "</span>";
      host.appendChild(h);
      g.items.forEach(function (b) { host.appendChild(bookingRow(b, g.key)); });
    });
    if (!any) host.innerHTML = '<p style="color:var(--faint);padding:26px 4px;">No bookings yet. Find an act under Discover and send your first request.</p>';
  }

  function renderStats() {
    var t = todayISO();
    var confirmed = state.bookings.filter(function (b) { return b.status === "ok" && b.dateISO >= t; });
    var completed = state.bookings.filter(function (b) { return b.status === "ok" && b.dateISO < t; });
    var pending = state.bookings.filter(function (b) { return b.status === "pend" || b.status === "acc"; });
    var total = state.bookings.filter(function (b) { return b.status === "ok"; }).reduce(function (sm, b) { return sm + (b.fee || 0); }, 0);
    var spendLabel = state.role === "venue" ? "Entertainment spend" : "Earnings";
    $("stats").innerHTML =
      '<div class="stat"><p class="k">Upcoming</p><p class="v">' + confirmed.length + '</p><p class="d">Confirmed future gigs</p></div>' +
      '<div class="stat"><p class="k">Pending</p><p class="v">' + pending.length + '</p><p class="d">Awaiting reply or finalization</p></div>' +
      '<div class="stat"><p class="k">Completed</p><p class="v">' + completed.length + '</p><p class="d">Previous gigs</p></div>' +
      '<div class="stat"><p class="k">' + spendLabel + '</p><p class="v">&euro;' + total + '</p><p class="d">All confirmed bookings</p></div>';
  }

  /* ---------- reviews ---------- */
  var revTarget = null, revScore = 0;
  function openReview(b) {
    revTarget = b;
    revScore = 0;
    $("revSub").textContent = (state.role === "venue" ? b.artistName + " at " + b.venueName : b.venueName) + " · " + fmt(b.dateISO);
    document.querySelectorAll("#revStars button").forEach(function (x) { x.classList.remove("on"); });
    $("revNote").value = "";
    $("revBg").classList.add("on");
  }
  document.querySelectorAll("#revStars button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      revScore = parseInt(btn.dataset.s, 10);
      document.querySelectorAll("#revStars button").forEach(function (x) {
        x.classList.toggle("on", parseInt(x.dataset.s, 10) <= revScore);
      });
    });
  });
  $("revClose").addEventListener("click", function () { $("revBg").classList.remove("on"); });
  $("revBg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("revForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!revTarget || !revScore) { toast("Pick a star rating first."); return; }
    /* API: submit review */
    revTarget.rated = revScore;
    notify(state.role === "venue" ? "artist" : "venue", (state.role === "venue" ? revTarget.venueName : revTarget.artistName) + " rated your gig on " + fmt(revTarget.dateISO) + ": " + revScore + " of 5.", "bookings");
    save();
    $("revBg").classList.remove("on");
    renderBookings();
    toast("Review submitted. Ratings build trust on both sides of The Book.");
  });

  /* ---------- create profile / gig call ---------- */
  $("addBtn").addEventListener("click", function () {
    if (state.role === "venue") {
      $("ngVenue").value = state.name || "";
      $("ngCounty").value = state.county || "Meath";
      $("newGigBg").classList.add("on");
    } else {
      $("naName").value = state.name || "";
      $("naCounty").value = state.county || "Meath";
      $("newArtBg").classList.add("on");
    }
  });
  document.querySelectorAll("[data-close]").forEach(function (b) {
    b.addEventListener("click", function () { $(b.dataset.close).classList.remove("on"); });
  });
  ["newArtBg", "newGigBg"].forEach(function (id) {
    $(id).addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  });

  $("newArtForm").addEventListener("submit", function (e) {
    e.preventDefault();
    /* API: create artist profile */
    var genre = $("naStyle").value;
    var type = $("naType").value;
    var icons = { "Band": "band", "Solo": "voice", "Duo or trio": "guitar", "DJ": "dj" };
    var yrs = clampInt($("naExp").value, 0);
    var fee = clampInt($("naFee").value, 0) || null;
    state.artists.unshift({
      id: nid(), name: $("naName").value.trim(), type: type, county: $("naCounty").value,
      genres: [genre], icon: icons[type] || "band",
      feeMin: fee, feeMax: fee ? Math.round(fee * 1.5 / 10) * 10 : null, rating: null, gigs: null,
      exp: yrs ? yrs + " years" : "New on the roster",
      busy: [], bio: $("naBio").value.trim() || "Profile details to be added."
    });
    save();
    $("newArtBg").classList.remove("on");
    toast("Profile published. Venues browsing Discover can now find and book you.");
    if (state.role === "venue") renderGrid();
  });

  $("newGigForm").addEventListener("submit", function (e) {
    e.preventDefault();
    /* API: create gig call */
    state.gigcalls.unshift({
      id: nid(), venue: $("ngVenue").value.trim(), county: $("ngCounty").value,
      dateISO: $("ngDate").value, slot: "Live music", budget: clampInt($("ngBudget").value, 0) || null,
      styles: [$("ngStyle").value], bio: $("ngBio").value.trim() || "Details on request."
    });
    save();
    $("newGigBg").classList.remove("on");
    toast("Gig call posted. Acts browsing Discover can now apply.");
    if (state.role === "artist") renderGrid();
  });

  /* ---------- booking-centred messaging ---------- */
  var activeThread = null;
  function ensureThread(name) {
    var t = state.threads.filter(function (x) { return x.name === name; })[0];
    if (!t) { t = { id: nid(), name: name, msgs: [] }; state.threads.unshift(t); }
    return t;
  }
  function openChat(name) {
    var t = ensureThread(name);
    activeThread = t.id;
    $("chatHead").textContent = t.name;
    renderChat();
    $("chatBg").classList.add("on");
  }
  function renderChat() {
    var t = state.threads.filter(function (x) { return x.id === activeThread; })[0];
    if (!t) return;
    var log = $("chatLog");
    log.innerHTML = "";
    if (!t.msgs.length) log.innerHTML = '<p style="color:var(--faint);font-size:0.85rem;">No messages yet. Say hello and sort the details.</p>';
    t.msgs.forEach(function (m) {
      var d = document.createElement("div");
      d.className = "bub " + (m.from === state.role ? "me" : "them");
      d.innerHTML = esc(m.t) + "<small>" + esc(m.when) + "</small>";
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
  }
  $("chatClose").addEventListener("click", function () { $("chatBg").classList.remove("on"); });
  $("chatBg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("chatForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("chatInput").value.trim();
    if (!v) return;
    var t = state.threads.filter(function (x) { return x.id === activeThread; })[0];
    if (!t) return;
    /* API: send message */
    t.msgs.push({ from: state.role, t: v, when: new Date().toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" }) });
    $("chatInput").value = "";
    save();
    renderChat();
  });

  /* ---------- profile ---------- */
  function mediaPlatforms() {
    return Object.keys(SOCIAL).filter(function (p) { return SOCIAL[p].isMedia; });
  }
  function fillPlatformSelect(sel, list) {
    if (!sel) return;
    sel.innerHTML = list.map(function (p) {
      return '<option value="' + p + '">' + esc(SOCIAL[p].label) + "</option>";
    }).join("");
  }
  function setMsg(el, text, good) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "field-msg" + (text ? (good ? " good" : " bad") : "");
  }

  function renderLinkList() {
    var host = $("pfLinkList");
    if (!host) return;
    var links = linksOf(state);
    if (!links.length) { host.innerHTML = '<p class="field-msg">No links added yet.</p>'; return; }
    host.innerHTML = links.map(function (l, i) {
      var label = SOCIAL[l.platform] ? SOCIAL[l.platform].label : l.platform;
      return '<div class="link-row">' + (PLATFORM_ICONS[l.platform] || "")
        + '<span class="link-row-label">' + esc(label) + "</span>"
        + '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.url) + "</a>"
        + '<button class="x" type="button" data-i="' + i + '" aria-label="Remove ' + esc(label) + ' link">&#215;</button></div>';
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll("button[data-i]"), function (b) {
      b.addEventListener("click", function () {
        /* API: delete profile link */
        state.links.splice(clampInt(b.getAttribute("data-i"), 0), 1);
        save(); renderLinkList(); setMsg($("pfLinkMsg"), "");
        toast("Link removed.");
      });
    });
  }

  function renderClipList() {
    var host = $("pfClipList");
    if (!host) return;
    var media = mediaOf(state);
    if (!media.length) { host.innerHTML = '<p class="field-msg">No clips added yet.</p>'; return; }
    host.innerHTML = media.map(function (m, i) {
      var label = SOCIAL[m.platform] ? SOCIAL[m.platform].label : m.platform;
      return '<div class="link-row">' + (PLATFORM_ICONS[m.platform] || "")
        + '<span class="link-row-label">' + esc(label) + "</span>"
        + '<a href="' + esc(m.source) + '" target="_blank" rel="noopener noreferrer">' + esc(m.title || m.source) + "</a>"
        + '<button class="x" type="button" data-i="' + i + '" aria-label="Remove clip">&#215;</button></div>';
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll("button[data-i]"), function (b) {
      b.addEventListener("click", function () {
        /* API: delete profile media */
        state.media.splice(clampInt(b.getAttribute("data-i"), 0), 1);
        save(); renderClipList(); setMsg($("pfClipMsg"), "");
        toast("Clip removed.");
      });
    });
  }

  function renderProfile() {
    $("pfName").value = state.name || "";
    $("pfCounty").value = state.county || "Meath";
    $("pfType").value = state.role === "venue" ? "Venue" : "Artist";
    $("pfBio").value = state.bio || "";

    /* Venues get facebook / instagram / website only. The table does not care,
       the form does. */
    fillPlatformSelect($("pfPlatform"), platformsFor(state.role));
    fillPlatformSelect($("pfClipPlatform"), mediaPlatforms());

    /* Clips are artist-only in the UI. Nothing in the data stops a venue from
       having them later. */
    if ($("pfClipsWrap")) $("pfClipsWrap").style.display = state.role === "venue" ? "none" : "";

    setMsg($("pfLinkMsg"), "");
    setMsg($("pfClipMsg"), "");
    renderLinkList();
    renderClipList();
  }

  if ($("pfAddLink")) $("pfAddLink").addEventListener("click", function () {
    var msg = $("pfLinkMsg");
    var platform = $("pfPlatform").value;
    if (platformsFor(state.role).indexOf(platform) === -1) { setMsg(msg, "That platform is not available for this account type."); return; }
    if (linksOf(state).length >= MAX_LINKS) { setMsg(msg, "That is the maximum of " + MAX_LINKS + " links. Remove one first."); return; }
    if (linksOf(state).some(function (l) { return l.platform === platform; })) {
      setMsg(msg, "You already have a " + SOCIAL[platform].label + " link. Remove it first."); return;
    }
    var res = parseSocial(platform, $("pfLinkUrl").value);
    if (!res.ok) { setMsg(msg, res.error); return; }
    /* API: create profile link */
    state.links.push({ platform: platform, url: res.url });
    save();
    $("pfLinkUrl").value = "";
    setMsg(msg, "Added " + SOCIAL[platform].label + ".", true);
    renderLinkList();
  });

  if ($("pfAddClip")) $("pfAddClip").addEventListener("click", function () {
    var msg = $("pfClipMsg");
    var platform = $("pfClipPlatform").value;
    if (mediaPlatforms().indexOf(platform) === -1) { setMsg(msg, "Clips can only come from YouTube, Spotify or SoundCloud."); return; }
    if (mediaOf(state).length >= MAX_MEDIA) { setMsg(msg, "That is the maximum of " + MAX_MEDIA + " clips. Remove one first."); return; }
    var res = parseSocial(platform, $("pfClipUrl").value);
    if (!res.ok) { setMsg(msg, res.error); return; }
    if (!res.embed) { setMsg(msg, "That link has nothing playable in it — use a link to a track or a video, not a profile."); return; }
    /* API: create profile media */
    state.media.push({
      kind: "link",
      platform: platform,
      source: res.url,
      title: String($("pfClipTitle").value || "").trim().slice(0, 120)
    });
    save();
    $("pfClipUrl").value = "";
    $("pfClipTitle").value = "";
    setMsg(msg, "Clip added.", true);
    renderClipList();
  });
  $("profForm").addEventListener("submit", function (e) {
    e.preventDefault();
    /* API: update profile */
    state.name = $("pfName").value.trim();
    state.county = $("pfCounty").value;
    state.bio = $("pfBio").value.trim();
    save();
    renderWho();
    toast("Profile saved.");
  });

  /* ---------- calendar ---------- */
  var today = new Date();
  var calM = today.getMonth(), calY = today.getFullYear();
  function renderCal() {
    $("calTitle").textContent = MONTHS[calM] + " " + calY;
    var grid = $("calGrid");
    grid.innerHTML = "";
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (d) {
      var h = document.createElement("div");
      h.className = "dow";
      h.textContent = d;
      grid.appendChild(h);
    });
    var first = new Date(calY, calM, 1);
    var lead = (first.getDay() + 6) % 7;
    var days = new Date(calY, calM + 1, 0).getDate();
    for (var i = 0; i < lead; i++) {
      var pad = document.createElement("div");
      pad.className = "day dim";
      grid.appendChild(pad);
    }
    for (var d = 1; d <= days; d++) {
      var cell = document.createElement("div");
      cell.className = "day";
      var cellISO = calY + "-" + String(calM + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      if (cellISO === iso(new Date())) cell.classList.add("today");
      cell.innerHTML = "<span>" + d + "</span>";
      state.bookings.forEach(function (b) {
        if (b.status === "bad" || b.dateISO !== cellISO) return;
        cell.classList.add("has");
        var g = document.createElement("div");
        g.className = "gig" + (b.status === "pend" || b.status === "acc" ? " pend" : "");
        g.textContent = state.role === "venue" ? b.artistName : b.venueName;
        g.title = b.artistName + " at " + b.venueName + " — " + b.slot;
        cell.appendChild(g);
      });
      grid.appendChild(cell);
    }
  }
  $("calPrev").addEventListener("click", function () { calM--; if (calM < 0) { calM = 11; calY--; } renderCal(); });
  $("calNext").addEventListener("click", function () { calM++; if (calM > 11) { calM = 0; calY++; } renderCal(); });

  /* ---------- reset ---------- */
  $("resetBtn").addEventListener("click", function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  });

  /* ---------- init ---------- */
  renderWho();
  setRole(state.role);
  showTab("home");
  if (!state.onboarded) $("onbBg").classList.add("on");
})();
