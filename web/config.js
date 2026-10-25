// Supabase project for anonymous telemetry (see supabase/schema.sql).
// The key is the public publishable key: with that schema it can only call
// ingest(), which appends rows. Leave both empty to turn telemetry off.
export const SUPABASE_URL = "https://cmwvxlbxhgtzqmiaivam.supabase.co";
export const SUPABASE_KEY = "sb_publishable_uIfP0Mwg3c076DxnFHJ9eQ_oC9f0QTD";
// Sign-in with Google and progress sync (sync.js). Turn on once Google is set up as a
// provider in Supabase (Authentication -> Providers) and the schema has public.progress.
export const GOOGLE_SYNC = true;
// Google OAuth client (public, as on any "Sign in with Google" button). Its JavaScript origin
// is https://zdaipdr.com.ua; Supabase accepts its ID tokens (Authentication -> Providers -> Google).
export const GOOGLE_CLIENT_ID = "689812929537-uch6r7d730kva5ga51tfmt2rh2iatqdi.apps.googleusercontent.com";
