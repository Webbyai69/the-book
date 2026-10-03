/* ================================================================
   The Book — deployment settings.

   Leave all three empty and the site runs as the self-contained demo
   (everything stored in this browser). Fill all three in and it runs
   live: sign-in through Supabase, data through the API.

   None of these are secrets. The Supabase anon key is designed to be
   public; the API checks every request's signed-in user itself.
   ================================================================ */
window.THE_BOOK_CONFIG = {
  /* The Worker's address plus /api, e.g.
     "https://the-book-api.your-subdomain.workers.dev/api" */
  apiBase: "",

  /* Supabase project: Project Settings > API */
  supabaseUrl: "",
  supabaseAnonKey: ""
};
