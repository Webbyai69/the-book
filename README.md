# The Book

Live entertainment, booked simply. Find. Book. Play.

The Book is a two-sided marketplace connecting bars, pubs, restaurants, hotels and other venues with local bands, musicians and DJs. This repository holds the working front-end prototype: discovery, availability, booking requests, finalization, messaging, reviews and gig management in one place.

## What works today

This is a fully functional client-side prototype. All state is stored in the browser (localStorage), so it runs on any static host with no backend.

- Onboarding: choose Venue or Artist, set your name and county
- Five-section navigation: Home, Discover, Calendar, Bookings, Profile
- Discover: search acts by county, act type (band, solo, duo or trio, DJ) and genre (rock, pop, country, jazz, indie, electronic, folk, trad), with fee ranges on profiles
- Availability: each act has calendar-linked availability; the date picker shows whether the chosen date is free or booked
- Booking flow: venue sends a request with date, start and finish times and an offer; the artist is notified and accepts or declines
- On accept: the venue finalizes price, deposit (with balance calculated), arrival and soundcheck times, and the booking is confirmed in both calendars
- On decline: the venue is offered a similar act, matched on genre, act type and availability for that exact date
- Bookings are grouped Pending, Upcoming, Completed and Cancelled
- Messaging stays attached to bookings; each booking row opens its own conversation
- Two-way reviews: after a completed gig both sides can rate the night
- Gig calls: venues post open dates, artists apply
- Notification bell drives the whole lifecycle across the role switch
- Fully responsive, works on phones

To try both sides of a booking on one device, use the Venue and Artist switch in the header. The footer has a reset link that restores the seed data.

## Run it locally

No build step. Either open `index.html` directly in a browser, or serve the folder:

```
python3 -m http.server 8080
```

and open http://localhost:8080

## Free hosting with GitHub Pages

Once this repository is on GitHub: Settings, then Pages, then under Build and deployment choose Deploy from a branch, select the main branch and the root folder, and save. The site will be live at `https://<username>.github.io/<repository-name>/` within a minute or two.

## Project structure

```
index.html      app shell and all markup (views, modals, drawer)
css/styles.css  design system: deep green and gold identity, all components
js/app.js       app engine: state, persistence, rendering, booking lifecycle
assets/         the harp roundel logo
```

## Connecting a real backend

The prototype keeps every read and write behind one `state` object in `js/app.js`, persisted through `load()` and `save()`. Every mutation point that a server should own is marked with an `API:` comment (create booking, update status, send message, create profile, create gig call, submit review). Replacing localStorage with API calls at those points converts this UI into the real product without redesigning screens. A production build additionally needs accounts and authentication, a database, push notifications, and media uploads for artist photos and videos.

## Roadmap ideas

Payments (deposit and balance through the platform), a commission or venue-subscription revenue model, artist media galleries, distance-based search, and a Fill My Date feature for last-minute cancellations on either side.
