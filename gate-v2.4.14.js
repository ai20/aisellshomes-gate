/* aisellshomes gate v2.4.14 — external gate, loaded from Lofty bootstrap
 *
 * Changes from v2.4.13:
 *   Adds /api-site/leaveMsg handler so Contact Inquiry (CI) fires for the
 *   inline "GET MORE INFORMATION" form on listing-detail pages, which hits
 *   leaveMsg (not leadRegister). Same dedup via djb2(email), same Zapier
 *   beacon as the leadRegister branch. No change to any other label.
 *
 * Changes from v2.4.9:
 *   (no behavioral change) — version bumped to match server release
 *   that adds the Lofty lead-existence verifier, the trusted-attribution
 *   promotion endpoint, and the deterministic concurrency test hook. The
 *   gate's BC receiver, consent-category logic, and beacon fields are
 *   identical to v2.4.9.
 *
 *
 * Changes from v2.4.8:
 *   Z. Cross-tab ordering preserved even on no-change messages.
 *      Reviewer-reproduced sequence on v2.4.8:
 *        Local ad=denied, __aisfLastBCts=1000.
 *        Message arrives ts=3000 with ad=denied (no change) → `if (!r.changed)
 *          return` returned BEFORE advancing __aisfLastBCts. Timestamp stayed at 1000.
 *        Message arrives ts=2000 with ad=granted → ts=2000 > lastBCts=1000 → accepted,
 *          reversing the newer denial.
 *      Fix: advance __aisfLastBCts to +ev.data.ts on ANY valid newer-or-tie message
 *      BEFORE the changed check. The subsequent ts=2000 is then 'older' and rejected.
 *
 * Changes from v2.4.7:
 *   W. Cross-tab granular-consent race: v2.4.7's fix Q accepted the ENTIRE
 *      incoming payload when any single category was denied. That allowed
 *      a Tab-A ad_storage=denied/analytics=granted + Tab-B
 *      ad_storage=granted/analytics=denied simultaneous click to swap
 *      BOTH categories between tabs, because the whole payload moved as
 *      a unit. v2.4.8 resolves each category independently on tie:
 *        - If either side is denied → resolved = 'denied' (union-of-denials).
 *        - Otherwise (both granted or mixed with unknowns) → no change.
 *      A denial in category X cannot reverse a denial in category Y. For
 *      strictly-newer messages (ts > lastBCts) the remote wins outright
 *      per category — that is a later authoritative choice, not a race.
 *
 *      The resolver lives in server/lib.js as resolveConsentOnTieOrNewer
 *      and is embedded in this gate at the top (see "AISF_PURE_TIE_BREAK"
 *      block below). Tests import the ONE copy; this gate and the test
 *      suite share one definition.
 *
 *   -- Known residual (unchanged from v2.4.7): BroadcastChannel can drop
 *      messages when a tab is suspended or closed. In-browser recovery
 *      does not exist; server-side Firestore consent_records with
 *      monotonic consent_version is the authoritative ordering source.
 *
 * Changes from v2.4.6:
 *   Q. (superseded by W in v2.4.8 — per-category instead of all-or-nothing)
 *
 * Changes from v2.4.5:
 *   N. Local (non-BC) consent updates also advance __aisfLastBCts to
 *      Date.now(). Prevents the ordering hole: a local withdrawal at
 *      time T2 would previously leave __aisfLastBCts=0, so a replayed
 *      older BC grant at T1 could be accepted. Now rejected.
 *
 * Changes from v2.4.4:
 *   M. Cross-tab consent sync breaks the rebroadcast loop. Updates applied
 *      by the BroadcastChannel receiver are marked with __aisf_source='bc'
 *      in the gtag payload; the dataLayer wrapper detects this and does
 *      NOT rebroadcast. A per-payload timestamp (ts) orders updates — the
 *      receiver ignores any payload with ts <= __aisfLastBCts, so a
 *      replayed older grant cannot reverse a newer withdrawal.
 *
 * Changes from v2.4.3:
 *   I. BroadcastChannel sends the FULL Lofty consent payload (all 7 Google
 *      categories), not a {state:'granted'|'denied'} flag. Receivers mirror
 *      exactly — cannot grant ad_user_data when the sending tab didn't.
 *   J. visibilitychange handler no longer dispatches gtag('consent','update')
 *      with a blanket _CG/_CD object. On refocus, it only verifies the
 *      beacon's own fail-closed conditions are still met; it does NOT
 *      override granular category choices. If a tab needs to pick up a
 *      new consent state set in another tab, a BroadcastChannel message
 *      from that tab is the authoritative path.
 *   K. Beacon payload adds click_ts (parsed from _gcl_aw cookie when the
 *      format GCL.<unix_seconds>.<gclid> is present). IMPORTANT: this
 *      timestamp is the cookie-write time, which is typically when the
 *      gclid first arrived — but its provenance is not cryptographically
 *      verified by Google. Treated as "indicative", not "authoritative".
 *   L. Beacon payload adds lead_id captured from the XHR response's
 *      r.data.user.id when Lofty confirms the lead. Browser does not
 *      forge this; it comes from Lofty's authenticated response.
 *
 * Changes from v2.4.2:
 *   F. Explicit ad_user_data consent capture. The gate maintains
 *      window.__aisfConsent as a local snapshot of the latest consent
 *      state observed via dataLayer.push([consent, default|update, …]).
 *      Beacon fires ONLY when both Lofty's targeting cookie AND the
 *      captured ad_user_data signal are 'granted'. Unknown fails closed.
 *   G. Beacon payload now carries a consent object. Server treats it as
 *      an UNVERIFIED browser-reported snapshot — never as authoritative.
 *      Server-side promotion to authoritative consent requires a distinct,
 *      Lofty-authenticated signal through /v1/affirm-consent.
 *   H. Policy version tag: GATE_V = 'v2.4.4' recorded with every beacon
 *      payload so downstream can correlate payload shape with gate release.
 *
 * Changes from v2.4.1:
 *   D. Storage-access exceptions in the legacy-cleanup branch are now
 *      wrapped in try/catch (handles iOS Safari private mode and any user
 *      agent that throws on localStorage access).
 *   E. One-time purge of raw-email LS dedup keys written by v2.3 / v2.4.0
 *      (scans keys matching /^(AW-11477399151\/|aisfBeacon:).*@/ and removes).
 *
 * Changes from v2.4.0:
 *   A. Clear legacy ais_gclid on no-consent page load (purges pre-v2.4 state).
 *   B. navigator.sendBeacon fallback to fetch(keepalive) on failure.
 *   C. Hash email in localStorage dedup keys via a 32-bit non-cryptographic
 *      hash (djb2 → base-36). Not encryption; not anonymization; a
 *      collision-tolerable key for dedup only.
 *
 * Preserves every tracker from v2.3. Adds:
 *   - Consent Mode default is set by the inline bootstrap (not here) so it hits
 *     the dataLayer before any gtag config command.
 *   - Zapier beacon fires on CONFIRMED LOFTY LEAD CREATION (XHR 2xx with
 *     r.status.code===0 AND r.data.user.id), gated on targeting consent.
 *   - dataLayer-hook for ['consent','update',...] events: persist ais_gclid on
 *     grant (recovered from URL), clear on deny.
 *   - Cross-tab consent sync via BroadcastChannel + visibilitychange.
 *   - Self-contained consent category definitions.
 *
 * Expects window.dataLayer and window.gtag to be initialized by the inline
 * Lofty bootstrap, and gtag('consent','default', ...) already dispatched there.
 *
 * SRI: computed from the exact bytes of this file after hosting. Do not change
 * contents without updating the hash in the bootstrap.
 */

/* ============================================================
 * AISF_PURE_TIE_BREAK (v2.4.8, fix W)
 * ------------------------------------------------------------
 * Per-category tie-break reducer. Shared between the browser gate
 * (BC receiver below uses window.__aisfGate.resolveConsentOnTieOrNewer)
 * and the test suite (Node tests require this file directly). One
 * definition, no separate copy.
 *
 * mode = 'tie'    — same-ms tie: per-category denial-wins.
 * mode = 'newer'  — remote strictly newer: remote wins outright per
 *                   category.
 *
 * Returns { resolved, changed } where resolved is the per-category
 * delta to apply locally.
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  root.__aisfGate = root.__aisfGate || {};
  root.__aisfGate.resolveConsentOnTieOrNewer = api.resolveConsentOnTieOrNewer;
  root.__aisfGate.compareBCTimestamps = api.compareBCTimestamps;
  root.__aisfGate.CATEGORY_KEYS_ALL = api.CATEGORY_KEYS_ALL;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  var CATEGORY_KEYS_ALL = [
    'ad_storage','ad_user_data','ad_personalization','analytics_storage',
    'functionality_storage','personalization_storage','security_storage'
  ];
  function resolveConsentOnTieOrNewer(localCategories, incomingPayload, mode) {
    var local = localCategories || {};
    var inc = incomingPayload || {};
    var resolved = {};
    var changed = false;
    var newer = mode === 'newer';
    for (var i = 0; i < CATEGORY_KEYS_ALL.length; i++) {
      var k = CATEGORY_KEYS_ALL[i];
      var localVal = local[k];
      var incVal = inc[k];
      if (incVal !== 'granted' && incVal !== 'denied') continue;
      if (newer) {
        if (localVal !== incVal) { resolved[k] = incVal; changed = true; }
        continue;
      }
      // Tie mode: per-category denial-wins.
      if (incVal === 'denied' && localVal !== 'denied') {
        resolved[k] = 'denied'; changed = true; continue;
      }
      if (incVal === 'granted') {
        if (localVal === 'denied') continue; // never reverse a denial on tie
        if (localVal !== 'granted') { resolved[k] = 'granted'; changed = true; }
        continue;
      }
    }
    return { resolved: resolved, changed: changed };
  }
  function compareBCTimestamps(ts, lastBCts) {
    var n = +ts;
    if (!isFinite(n)) return 'invalid';
    if (n < lastBCts) return 'older';
    if (n === lastBCts) return 'tie';
    return 'newer';
  }
  return { resolveConsentOnTieOrNewer: resolveConsentOnTieOrNewer, compareBCTimestamps: compareBCTimestamps, CATEGORY_KEYS_ALL: CATEGORY_KEYS_ALL };
});

/* Everything below is browser-only. Guarded so Node require() of this
 * file (from tests) exits before touching window/document. */
if (typeof window === 'undefined' || typeof document === 'undefined') {
  // Node — resolver has already been exported via module.exports. Stop.
} else { (function(){
"use strict";

/* --- Consent category constants (self-contained) --- */
var _ALL = 'ad_storage,ad_user_data,ad_personalization,analytics_storage,functionality_storage,personalization_storage,security_storage'.split(',');
var _CD = {}, _CG = {};
_ALL.forEach(function(k){ _CD[k] = 'denied'; _CG[k] = 'granted'; });
_CD.security_storage = 'granted';

/* --- Constants --- */
var Z = 'https://hooks.zapier.com/hooks/catch/9189623/49wykqa/';
var SIG = 'AW-11477399151/0ShbCPTH96sdEO_s7OAq',
    CI  = 'AW-11477399151/4ajgCITJqLAdEO_s7OAq',
    EC  = 'AW-11477399151/L0EfCOD9xLMdEO_s7OAq',
    MT  = 'AW-11477399151/qBwLCKiX1rAdEO_s7OAq';
var GATE_V = 'v2.4.13';
/* Monotonic ordering for cross-tab consent sync. Any received BC payload
 * with ts <= this is ignored (older or replayed). */
window.__aisfLastBCts = window.__aisfLastBCts || 0;

/* --- Consent snapshot (browser-reported; NOT authoritative) ---
 * Maintained by the dataLayer.push wrapper below. The bootstrap pushes the
 * default BEFORE this file loads, so initial unknown state is replaced by
 * 'denied' as soon as our wrapper is installed and processes the pending
 * dataLayer entries — but if that push already happened before we got here,
 * we read the current ICS entries once to seed. Seeding uses the browser-
 * reported value; if the ICS reader is unavailable or shape is unknown,
 * we leave the field as 'unknown' and fail closed downstream. */
window.__aisfConsent = window.__aisfConsent || {
  targeting: 'unknown',
  ad_storage: 'unknown',
  ad_user_data: 'unknown',
  ad_personalization: 'unknown',
  analytics_storage: 'unknown',
  functionality_storage: 'unknown',
  personalization_storage: 'unknown',
  updated_at: null,
  source: 'unknown',
  gate_version: GATE_V
};
function _mapConsent(v){ return (v === 'granted' || v === 'denied') ? v : 'unknown'; }
function _applyConsentPayload(cmd, payload){
  if (!payload || typeof payload !== 'object') return;
  var keys = ['ad_storage','ad_user_data','ad_personalization','analytics_storage','functionality_storage','personalization_storage'];
  var any = false;
  for (var i = 0; i < keys.length; i++){
    if (payload[keys[i]] !== undefined){
      window.__aisfConsent[keys[i]] = _mapConsent(payload[keys[i]]);
      any = true;
    }
  }
  if (any){
    window.__aisfConsent.updated_at = Date.now();
    window.__aisfConsent.source = cmd === 'default' ? 'consent_default' : 'consent_update';
  }
}
/* Seed from current ICS if our wrapper installs late. The field names below
 * are documented in Google's Consent Mode reference, but their internal
 * shape is implementation-defined. Any shape mismatch → leave as unknown. */
try {
  var _ics = window.google_tag_data && window.google_tag_data.ics && window.google_tag_data.ics.entries;
  if (_ics) {
    ['ad_storage','ad_user_data','ad_personalization','analytics_storage','functionality_storage','personalization_storage'].forEach(function(k){
      var e = _ics[k];
      if (e && typeof e.update === 'boolean') {
        window.__aisfConsent[k] = e.update ? 'granted' : 'denied';
        window.__aisfConsent.source = 'ics_seed';
        window.__aisfConsent.updated_at = Date.now();
      }
    });
  }
} catch(e) {}

/* --- Helpers --- */
function cs(){
  try {
    var m = document.cookie.match(/cookie_status_settings=([^;]+)/);
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  } catch(e) { return null; }
}
function ok(){ var c = cs(); return !!(c && c.targeting === true); }
function gc(){
  return new URLSearchParams(location.search).get('gclid')
      || localStorage.getItem('ais_gclid')
      || (document.cookie.match(/ais_gclid=([^;]+)/) || [])[1];
}
function PG(g){
  try { localStorage.setItem('ais_gclid', g); } catch(e) {}
  document.cookie = 'ais_gclid=' + encodeURIComponent(g) + '; max-age=7776000; path=/; samesite=lax';
}
function CG(){
  try { localStorage.removeItem('ais_gclid'); } catch(e) {}
  document.cookie = 'ais_gclid=; max-age=0; path=/';
}
/* Extract click timestamp from _gcl_aw cookie when format is GCL.<unix_seconds>.<gclid>
 * Returns null if format doesn't match exactly — never fabricated. */
function clickTs(){
  try {
    var m = document.cookie.match(/_gcl_aw=([^;]+)/);
    if (!m) return null;
    var parts = decodeURIComponent(m[1]).split('.');
    if (parts.length < 3 || parts[0] !== 'GCL') return null;
    var secs = parseInt(parts[1], 10);
    if (!isFinite(secs) || secs < 1600000000 || secs > 9999999999) return null;
    return secs * 1000;
  } catch(e) { return null; }
}
/* djb2 hash — used to avoid storing raw email in localStorage dedup keys */
function H(s){ var h = 5381, i = s.length; while(i) h = (h * 33) ^ s.charCodeAt(--i); return (h >>> 0).toString(36); }

/* --- One-time purge of raw-email LS dedup keys from v2.3 / v2.4.0 ---
 * Storage access is wrapped in try/catch — iOS Safari private mode throws on
 * any localStorage interaction; init must not abort. */
try {
  var _k, _rm = [];
  for (_k in localStorage) {
    if (/^(AW-11477399151\/|aisfBeacon:).*@/.test(_k)) _rm.push(_k);
  }
  for (var _i = 0; _i < _rm.length; _i++) {
    try { localStorage.removeItem(_rm[_i]); } catch(e) {}
  }
} catch(e) {}

/* --- Landing-time GCLID handling ---
 * If consent already granted (e.g. accepted earlier in another tab), persist
 * the URL gclid. If NOT consented, clear any legacy ais_gclid storage left by
 * a prior v2.3 unconditional-write session. All storage access is guarded. */
if (ok()) {
  var urlGclid = new URLSearchParams(location.search).get('gclid');
  if (urlGclid) PG(urlGclid);
} else {
  var _legacy = false;
  try { _legacy = !!localStorage.getItem('ais_gclid'); } catch(e) {}
  if (!_legacy) { try { _legacy = /ais_gclid=/.test(document.cookie); } catch(e) {} }
  if (_legacy) CG();
}

/* --- dataLayer hook: react to Lofty's ['consent','default'|'update',...] ---
 * - Maintains window.__aisfConsent snapshot (fix F).
 * - On update→granted for ad_storage: recover URL gclid, persist, broadcast.
 * - On update→denied for ad_storage: clear ais_gclid, broadcast.
 * - Broadcast carries the FULL category payload (fix I) so receiver tabs
 *   mirror granular choices and cannot grant categories the user didn't
 *   affirmatively select.
 * - BC-sourced updates (a[2].__aisf_source === 'bc') are applied locally
 *   but NOT rebroadcast (fix M). Prevents an infinite A↔B ping-pong. */
var _p = window.dataLayer.push;
window.dataLayer.push = function(){
  try {
    var a = arguments[0];
    if (a && a[0] === 'consent' && (a[1] === 'default' || a[1] === 'update') && a[2]) {
      var sourceIsBC = a[2].__aisf_source === 'bc';
      _applyConsentPayload(a[1], a[2]);
      if (a[1] === 'update') {
        /* fix N: local consent updates also advance __aisfLastBCts so a
         * replayed older BC grant cannot be accepted after a local
         * withdrawal. BC-sourced updates already advanced it in the
         * receiver before dispatching to gtag. */
        if (!sourceIsBC) {
          var _nowTs = Date.now();
          if (_nowTs > window.__aisfLastBCts) window.__aisfLastBCts = _nowTs;
        }
        if (a[2].ad_storage === 'granted') {
          var G = new URLSearchParams(location.search).get('gclid');
          if (G) PG(G);
        } else if (a[2].ad_storage === 'denied') {
          CG();
        }
        if (!sourceIsBC) {
          try {
            if (window.__aisfBC) {
              var payload = {};
              ['ad_storage','ad_user_data','ad_personalization','analytics_storage','functionality_storage','personalization_storage','security_storage'].forEach(function(k){
                if (a[2][k] === 'granted' || a[2][k] === 'denied') payload[k] = a[2][k];
              });
              if (Object.keys(payload).length) {
                window.__aisfBC.postMessage({ type: 'consent_update', payload: payload, ts: Date.now() });
              }
            }
          } catch(e) {}
        }
      }
    }
  } catch(e) {}
  return _p.apply(this, arguments);
};

/* --- Cross-tab consent sync via BroadcastChannel (fixes I, M, W) ---
 * Receiver resolves each category independently against the local
 * snapshot using the shared resolveConsentOnTieOrNewer reducer (see the
 * AISF_PURE_TIE_BREAK block at the top of this file). No whole-payload
 * accept/reject — a denial in one category cannot reverse a denial in
 * another.
 *
 * Ordering:
 *   ts <  lastBCts  → strictly older, reject (replayed message).
 *   ts === lastBCts → same-ms tie. Per-category denial-wins resolution.
 *   ts >  lastBCts  → strictly newer, per-category remote wins.
 *
 * The gtag('consent','update', mirror) call carries __aisf_source='bc'
 * so our own dataLayer wrapper recognizes it and does NOT rebroadcast —
 * breaking the A→B→A loop. */
try {
  window.__aisfBC = new BroadcastChannel('aisf-consent');
  window.__aisfBC.onmessage = function(ev){
    if (!ev.data || ev.data.type !== 'consent_update' || !ev.data.payload) return;
    var cmp = window.__aisfGate.compareBCTimestamps(ev.data.ts, window.__aisfLastBCts);
    if (cmp === 'invalid' || cmp === 'older') return;
    /* fix Z (v2.4.9): advance __aisfLastBCts for ANY valid newer-or-tie
     * message BEFORE the changed check. A redundant newer message whose
     * values match local state must still advance the clock, or a later
     * older message with ts between old-lastBCts and the-newer-but-redundant-ts
     * would be incorrectly accepted. */
    window.__aisfLastBCts = +ev.data.ts;
    var r = window.__aisfGate.resolveConsentOnTieOrNewer(
      window.__aisfConsent,
      ev.data.payload,
      cmp /* 'tie' | 'newer' */
    );
    if (!r.changed) return;
    var mirror = { __aisf_source: 'bc' };
    var cats = window.__aisfGate.CATEGORY_KEYS_ALL;
    for (var i = 0; i < cats.length; i++) {
      var k = cats[i];
      if (r.resolved[k] === 'granted' || r.resolved[k] === 'denied') mirror[k] = r.resolved[k];
    }
    try { window.gtag('consent', 'update', mirror); } catch(e) {}
    if (mirror.ad_storage === 'granted') {
      var G = new URLSearchParams(location.search).get('gclid');
      if (G) PG(G);
    } else if (mirror.ad_storage === 'denied') {
      CG();
    }
  };
} catch(e) {}

/* --- visibilitychange (fix J) ---
 * No longer dispatches gtag('consent','update'). The receiver's correct
 * state is maintained by BroadcastChannel from the tab where the user
 * actually clicked. On refocus, we only ensure OUR beacon fail-closed
 * conditions re-evaluate when the next form submit fires — no action
 * needed here. Removed to prevent accidental category granting. */

/* --- GTM-KCXW54M2 placeholder (defensive, preserved from v2.3) --- */
(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-KCXW54M2');

/* --- Google Ads tag loader + config --- */
(function(){ var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=AW-11477399151'; document.head.appendChild(s); })();
window.gtag('config', 'AW-11477399151');

/* --- Home Valuation (fires on /evaluation with evaluationId= in URL) --- */
(function(){
  var f;
  var c = function(){
    if (!f && location.search.indexOf('evaluationId=') > -1) {
      f = 1;
      window.gtag('event', 'conversion', { send_to: 'AW-11477399151/ebBxCIKL3KkdEO_s7OAq' });
    }
  };
  c();
  var o = history.replaceState;
  history.replaceState = function(){
    var r = o.apply(this, arguments);
    c();
    return r;
  };
})();

/* --- XHR gate: Signup, Contact Inquiry, Email Capture, Appointment Booked
 *      AND Zapier beacon, all fired on CONFIRMED LEAD CREATION. --- */
(function(){
  var _g = window.gtag, LF = {};

  /* Block any direct SIG/CI conversion from other code paths */
  window.gtag = function(){
    var a = arguments, t = a[2] && a[2].send_to;
    if (t === SIG || t === CI) return;
    return _g.apply(this, a);
  };

  /* Per-key 5-minute dedupe using localStorage, with in-memory fallback */
  function D(K){
    var t = Date.now();
    try {
      var p = +localStorage[K];
      if (p > t - 3e5) return 1;
      localStorage[K] = t;
    } catch(x) {
      if (LF[K] > t - 3e5) return 1;
      LF[K] = t;
    }
  }

  /* Fire Zapier beacon — dual-gated, deduped per email (hashed key).
   *
   * Required for fire:
   *   1. Lofty cookie_status_settings.targeting === true   (ok())
   *   2. Browser-reported ad_user_data === 'granted'
   *
   * ad_user_data === 'unknown' or 'denied' FAILS CLOSED. The downstream
   * Firestore service treats the beacon payload as an UNVERIFIED
   * browser-reported snapshot — never as authoritative consent.
   *
   * sendBeacon fallback → fetch(keepalive) on failure. Rejected form
   * submissions never reach here (caller is the XHR success branch).
   * Payload includes click_ts (parsed from _gcl_aw cookie, null if
   * format unrecognized — not fabricated) and lead_id (from Lofty's
   * XHR response, not browser-asserted). */
  /* v2.4.13 — session-token minting.
   *
   * On landing with a GCLID present AND ad_user_data=granted, call the
   * Cloud Run mint endpoint to obtain a server-signed provenance token
   * tied to this session. Store {token, session_id, click_ts_ms} in
   * localStorage under the GCLID key so the beacon can echo it later.
   *
   * window.__aisfMintUrl must be set by the Lofty bootstrap to the
   * operator-chosen Cloud Run URL (e.g., 'https://aisf-xyz.a.run.app').
   * If unset, the gate skips minting and the beacon falls back to
   * unverified_browser_snapshot — registration continues to work. */
  function mintIfMissing() {
    try {
      var mintBase = window.__aisfMintUrl;
      if (!mintBase) return;  // operator hasn't configured; fall back silently
      if (window.__aisfConsent.ad_user_data !== 'granted') return;
      var G = gc();
      if (!G) return;
      var gclid = decodeURIComponent(G);
      var storeKey = 'aisfProv:' + H(gclid);
      // Already minted for this gclid — reuse (survives tab reloads).
      try {
        var existing = localStorage.getItem(storeKey);
        if (existing) {
          var p = JSON.parse(existing);
          if (p && p.token && p.session_id && p.click_ts_ms) {
            window.__aisfProvenance = p;
            return;
          }
        }
      } catch(e) {}
      // Generate 128-bit session_id + 96-bit nonce from crypto.
      function b64url(bytes) {
        var s = btoa(String.fromCharCode.apply(null, bytes));
        return s.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      }
      var sidBytes = new Uint8Array(16); crypto.getRandomValues(sidBytes);
      var nonceBytes = new Uint8Array(12); crypto.getRandomValues(nonceBytes);
      var sid = b64url(sidBytes);
      var nonce = b64url(nonceBytes);
      fetch(mintBase.replace(/\/+$/, '') + '/v1/mint-session-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sid, gclid: gclid, nonce: nonce }),
        mode: 'cors',
        credentials: 'omit',
      }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
        if (j && j.token && j.click_ts_ms) {
          var prov = { token: j.token, session_id: sid, click_ts_ms: j.click_ts_ms, expires_at_ms: j.expires_at_ms };
          window.__aisfProvenance = prov;
          try { localStorage.setItem(storeKey, JSON.stringify(prov)); } catch(e) {}
        }
      }).catch(function(){ /* fail-open — beacon falls back */ });
    } catch(e) { /* never break registration */ }
  }

  /* Call mint opportunistically: on gate load (if GCLID + consent now),
   * and again after a consent update that grants ad_user_data late. */
  try { mintIfMissing(); } catch(e) {}
  try {
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) mintIfMissing(); });
  } catch(e) {}

  function fireBeacon(em, leadId){
    if (!em || !ok()) return;
    if (window.__aisfConsent.ad_user_data !== 'granted') return;
    var G = gc();
    if (!G) return;
    var key = em.trim().toLowerCase();
    if (D('aisfBeacon:' + H(key))) return;
    /* Try to attach the provenance block. If minting hasn't completed
     * (network race on fast form submit) the beacon still fires — the
     * server marks it unverified_browser_snapshot and downstream
     * promotion stays blocked. */
    var prov = window.__aisfProvenance || null;
    var payload = JSON.stringify({
      email: key,
      lead_id: leadId || null,
      gclid: decodeURIComponent(G),
      click_ts: clickTs(),
      ts: Date.now(),
      page: location.pathname,
      gate_version: GATE_V,
      provenance: prov ? { token: prov.token, session_id: prov.session_id } : null,
      consent: {
        targeting: ok() ? 'granted' : 'denied',
        ad_storage: window.__aisfConsent.ad_storage,
        ad_user_data: window.__aisfConsent.ad_user_data,
        ad_personalization: window.__aisfConsent.ad_personalization,
        analytics_storage: window.__aisfConsent.analytics_storage,
        source: window.__aisfConsent.source,
        updated_at: window.__aisfConsent.updated_at,
        captured_at: Date.now(),
        trust: 'unverified_browser_snapshot'
      }
    });
    var sent = false;
    try { sent = navigator.sendBeacon(Z, payload); } catch(e) {}
    if (!sent) {
      try { fetch(Z, { method: 'POST', body: payload, keepalive: true, mode: 'no-cors' }); } catch(e) {}
    }
  }

  var _o = XMLHttpRequest.prototype.open,
      _s = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(m, u){
    this.__u = u;
    return _o.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(b){
    this.__b = b;
    var u = this.__u || '', x = this;

    if (u.indexOf('leadRegister') > -1) {
      this.addEventListener('load', function(){
        try {
          if (x.status < 300) {
            var r = JSON.parse(x.responseText);
            if (r.status && r.status.code === 0) {
              var B = String(x.__b || ''),
                  em = (B.match(/"email":"([^"]+)"/i) || [,''])[1];
              /* Dedup keys use djb2(email) so raw emails never land in localStorage */
              var emH = em ? H(em.trim().toLowerCase()) : '';
              /* Confirmed full registration */
              if (u.indexOf('/auto/') < 0 && r.data && r.data.user && r.data.user.id) {
                var L = B.indexOf('question') > -1 ? CI : SIG;
                if (emH && D(L + emH)) return;
                _g('event', 'conversion', { send_to: L, value: 1, currency: 'USD' });
                _g('event', 'lofty_signup_submit', { event_category: 'Lofty Signup', event_label: location.pathname });
                fireBeacon(em, r.data.user.id);
              /* Confirmed Email Capture Step 1 (/auto/leadRegister) */
              } else if (u.indexOf('/auto/') > -1 && B.indexOf('email') > -1 && B.indexOf('phone') < 0 && B.indexOf('fullname') < 0) {
                if (emH && D(EC + emH)) return;
                _g('event', 'conversion', { send_to: EC });
                fireBeacon(em, (r.data && r.data.user && r.data.user.id) ? r.data.user.id : null);
              }
            }
          }
        } catch(e) {}
      });
    } else if (u.indexOf('/api-site/leaveMsg') > -1) {
      this.addEventListener('load', function(){
        try {
          if (x.status < 300) {
            var B = String(x.__b || ''),
                em = (B.match(/"email":"([^"]+)"/i) || [,''])[1];
            var emH = em ? H(em.trim().toLowerCase()) : '';
            if (emH && D(CI + emH)) return;
            _g('event', 'conversion', { send_to: CI, value: 1, currency: 'USD' });
            fireBeacon(em, null);
          }
        } catch(e) {}
      });
    } else if (u.indexOf('/meetings/schedule/') > -1) {
      this.addEventListener('load', function(){
        if (x.status < 300) _g('event', 'conversion', { send_to: MT });
      });
    }
    return _s.apply(this, arguments);
  };
})();

/* --- Popup funnel: shown / dismissed / submitted / abandoned --- */
(function(){
  var shown = 0, done = 0;
  function s(a){
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', 'aisf_popup_funnel', { event_category: 'Popup Funnel', event_action: a, event_label: location.pathname });
    var m = { shown: '9m7BCN6p4rAdEO_s7OAq', dismissed: 'rUeVCOGp4rAdEO_s7OAq', abandoned: 'oV8GCOSp4rAdEO_s7OAq' };
    if (m[a]) window.gtag('event', 'conversion', { send_to: 'AW-11477399151/' + m[a] });
  }
  var mo = new MutationObserver(function(){
    var p = !!document.querySelector('input[name="fullname"]');
    if (!shown && p) { shown = 1; s('shown'); }
    else if (shown && !done && !p) { done = 1; s('dismissed'); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('submit', function(e){
    if (shown && !done && e.target.querySelector && e.target.querySelector('[name="fullname"]')) {
      done = 1;
      s('submitted');
    }
  }, true);
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden' && shown && !done) {
      done = 1;
      s('abandoned');
    }
  });
})();

/* --- Listing Detail View (fires on /listing-detail/* on load/popstate/pushState) --- */
function __aisfLD(){
  if (location.pathname.indexOf('/listing-detail/') === 0) {
    window.gtag('event', 'conversion', { send_to: 'AW-11477399151/9IBUCIfJqLAdEO_s7OAq' });
  }
}
__aisfLD();
window.addEventListener('popstate', __aisfLD);
(function(){
  var p = history.pushState;
  history.pushState = function(){
    var r = p.apply(this, arguments);
    __aisfLD();
    return r;
  };
})();

/* --- Click delegate: tel / mailto / tour-button --- */
document.addEventListener('click', function(e){
  var t = e.target;
  if (t.closest('a[href^="tel:"]')) {
    window.gtag('event', 'conversion', { send_to: 'AW-11477399151/xDjwCJO-p7AdEO_s7OAq', value: 10, currency: 'USD' });
  } else if (t.closest('a[href^="mailto:"]')) {
    window.gtag('event', 'conversion', { send_to: 'AW-11477399151/_-pUCOKYorAdEO_s7OAq', value: 5, currency: 'USD' });
  } else if (t.closest('.item.tour,button.schedule-button,.person-tour')) {
    window.gtag('event', 'conversion', { send_to: 'AW-11477399151/ui0PCOWYorAdEO_s7OAq', value: 25, currency: 'USD' });
  }
}, true);

})(); } /* end of browser-only block */
