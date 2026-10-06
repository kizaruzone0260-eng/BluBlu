# Video Call Final Fix Report

Date: 2026-10-06 · Branch: `overnight` · Fix commit: see §11
Previous (insufficient) fix: `075e8a6` — «fix: restore video lesson authentication flow»

## 1. Actual Root Cause

The deployed CSRF/Origin gate rejected the page's **own** origin.

`apps/api/src/routes/auth.ts` → `checkSameOrigin()` treated the Origin header as a
strict allowlist whenever `PUBLIC_URL` or `DOMAIN` was configured, and deliberately
ignored the request's own `Host`. In the cloud deployment the address the UI is
actually served from (`https://blublu-api.onrender.com`) is not equal to the
configured `PUBLIC_URL`, and `PUBLIC_WEB_ORIGIN` was never configured at all (it is
absent from `render.yaml`, so it keeps its default `http://localhost:5173`). Result:
every `POST /api/auth/refresh` and `POST /api/auth/logout` from the real site was
answered **403 `forbidden`** — before any cookie, token or database logic ran.

The SPA then behaves exactly as designed for a dead session: `tryRefresh()` fails →
`setAccessToken(null)` (`apps/web/src/lib/api.ts`) → `/api/me` 401 → `fetchMe()` →
`null` → `App.tsx` renders `/login`. `POST /api/lessons/:id/join` and `room.connect()`
are never reached, so LiveKit/WebRTC is not involved.

The identical failure mode had already been fixed once in `fe50ec8` («refresh accepts
Origin==Host … killed session restore -> /lesson bounced to login») and then
re-introduced by `9573faa` («security(Phase1): … CSRF trusts configured Origin (not
Host)»), which is why the symptom appeared only in the cloud deploy.

The same rule is duplicated in `apps/api/src/lib/wsOrigin.ts` (WS-upgrade gate for
lesson/board/chat), so the lesson WebSocket would also have been refused from the
deployed page even after refresh.

## 2. First Failure

`POST /api/auth/refresh` → **403 `{"error":"forbidden"}`**, produced at
`routes/auth.ts:51` by `checkSameOrigin()` (called on line 128, i.e. before the
missing-cookie 401 on line 130). Everything after it in the trace is consequence.

## 3. Evidence

Browser (headless chromium with `--use-fake-device-for-media-stream` against the live
site, `apps/e2e/scripts/cloud-call-repro.mjs`, network preserve-log equivalent):

| # | Event | Status |
| --- | --- | --- |
| 1 | `POST /api/auth/login` | 200 |
| 2 | `GET /api/me` | 200 |
| 3 | `GET /api/classes`, `GET /api/chat/summary` | 200 |
| 4 | `GET /api/lessons/active?classId=…` | 200 |
| 5 | `POST /api/auth/refresh` | **403** ← FIRST FAILURE |
| 6 | `GET /api/me` | **401** (token dropped by the interceptor) |
| 7 | UI | renders Sign In; `start-lesson` locator never appears (`Timeout 15000ms`) |
| 8 | `POST /api/lessons/:id/join` | never sent |
| 9 | WebSocket / LiveKit | never attempted (0 events for the LiveKit host) |

Minimal probe of the same endpoint on production (isolates the gate from every other
cause — no cookies, no DB, no tokens involved):

```
POST /api/auth/refresh   Origin: https://blublu-api.onrender.com  → 403 {"error":"forbidden"}
POST /api/auth/refresh   (no Origin)                              → 401 {"error":"unauthorized"}
```

A missing refresh cookie can only produce the 401 on line 130; the 403 therefore came
from the Origin gate on line 128 → the failure is a header policy, not auth data.

Database (Supabase, read-only, using exactly the `DATABASE_URL` role the backend uses,
`apps/api/scripts/_prod_forensics.mjs`):

```
current_user / session_user : postgres / postgres
role attributes             : rolsuper=false  rolbypassrls=true  rolcanlogin=true
users table                 : owner=postgres  relrowsecurity=true  relforcerowsecurity=false
RLS coverage                : 35/35 tables rls_on, 0 forced
policies in public          : 35 rows, 35 × app_trusted_access   (migration 0020 IS applied)
owners of public tables     : postgres owns all 35
rows visible to the backend : users_all=1  users_live=1  classes=5  refresh_tokens=30
anon/authenticated          : present, has_table_privilege(anon, users, SELECT)=false,
                              authenticated holds SELECT on 0 tables
```

Deployment: `GET https://blublu-api.onrender.com/` carries
`<meta name="app-build" content="075e8a6">` — production **is** running the previous
fix commit, and it is still broken. CORS/rate-limit/health headers are served; the
CSP names the LiveKit origin (`wss://blublu-0jkqgsxt.livekit.cloud`), so the browser
layer is configured.

## 4. Why Previous Fix 075e8a6 Was Insufficient

`075e8a6` assumed the 401 came from RLS filtering `users` to zero rows for a
non-owner application role. §3 shows the production role is `postgres`, owns all
tables and has `rolbypassrls=true`, so policy-less RLS could never have hidden a row
from it: the app sees `users_live=1`, `/api/me` answers 200 and
`/api/lessons/active` answers 200. The RLS hypothesis was correct as a *local*
hardening gap (a future non-owner role would indeed be filtered — which is why the
`0020` policy and its test stay), but it was not the production cause. The real
production failure is one step earlier and in a different subsystem: an HTTP header
policy rejecting the site's own origin. Because dev/CI/e2e run with no
`PUBLIC_URL`/`DOMAIN`, the strict branch was unreachable there and every suite stayed
green on both commits.

## 5. Fix Applied

1. **`apps/api/src/lib/origin.ts` (new)** — one implementation of the Origin decision,
   used by both gates, so they cannot drift apart again:
   * accept an explicitly configured origin (`PUBLIC_WEB_ORIGIN`, the dev vite origin,
     `PUBLIC_URL`, `https://DOMAIN`), normalized (trim, lowercase, trailing `/`
     ignored — a pasted `https://host/` can no longer break the session);
   * **additionally accept an origin whose host equals the host the request arrived
     on** (the `fe50ec8` same-origin rule), which cannot be forged by a page: a
     browser sets both `Origin` and `Host` itself;
   * reject everything else, including malformed origins and host-suffix look-alikes
     (`https://blublu-api.onrender.com.attacker.example`).
   The file documents the threat model and the two-commit history
   (`fe50ec8` added → `9573faa` removed → restored) so the fallback is not stripped
   again.
2. **`apps/api/src/routes/auth.ts`** — `checkSameOrigin()` now delegates to
   `requestOriginAllowed()`; the 403 reply for genuinely cross-origin POSTs is kept.
3. **`apps/api/src/lib/wsOrigin.ts`** — `wsOriginAllowed()` delegates to the same
   helper (lesson/board/chat sockets get the identical, single rule).
4. **`render.yaml`** — declares `PUBLIC_WEB_ORIGIN` (value never in the repo) with the
   comment that it must be the origin the UI is opened from, and states that a
   same-origin request is accepted even if this drifts.
5. **`docs/HARDENING.md`** — row 1в-1 corrected to the rule as implemented plus row
   1в-1a describing this incident, so the doc no longer claims «Host is never trusted».

No database change, no rollback of `0020`, no RLS/`BYPASSRLS` change, no auth
architecture rewrite, no WebRTC/LiveKit change, no data touched, no security
mechanism disabled.

## 6. Files Changed

```
apps/api/src/lib/origin.ts                          (new)
apps/api/src/routes/auth.ts                         (gate delegates + comment)
apps/api/src/lib/wsOrigin.ts                        (gate delegates + comment)
apps/api/test/unit/origin-gate.test.ts              (new, 11 tests)
apps/api/test/integration/video-lesson-origin-drift.test.ts (new, 2 tests)
render.yaml                                         (PUBLIC_WEB_ORIGIN declared)
docs/HARDENING.md                                   (1в-1 corrected, 1в-1a added)
VIDEO_CALL_FINAL_FIX_REPORT.md                      (this file)
```

## 7. Security Impact

* Cross-site POSTs to `/api/auth/refresh` and `/api/auth/logout` are **still 403**; a
  cross-site WebSocket handshake is **still 4403**. Covered by the new
  `evil` / `*.evil.example` / port-mismatch assertions and by the pre-existing
  `phase1-hardening` («trust configured Origin, not Host») and `phase1-adversarial`
  («board WS rejects a cross-site Origin (4403)») tests, which still pass.
* Unauthenticated access is unchanged: `/api/me` without a token → 401, a forged
  bearer → 401, `authenticateTeacher` role mismatch → 403. Asserted in the new
  integration test.
* The added tolerance is strictly `Origin.host === request Host`, which a browser
  cannot be made to send for a cross-site page. A raw client that forges `Host` gains
  nothing: it would have to already hold the httpOnly refresh cookie, and a stolen
  token is handled by rotation + reuse-kill, not by this gate.
* Database posture untouched: RLS stays enabled on all 35 tables, `anon` and
  `authenticated` still hold zero privileges, no privileges were granted or revoked,
  no `BYPASSRLS` was introduced by this change (production's own role already had it).

## 8. Regression Tests

`apps/api/test/integration/video-lesson-origin-drift.test.ts`
— reproduces the deployed shape (`PUBLIC_URL` = another host, request `Host`/`Origin`
= the served host) and walks the whole broken chain:
`login → refresh → /api/me → POST /api/classes → /api/lessons/active →
/api/lessons/start → /api/lessons/:id/join` (the join response is the LiveKit token —
the step production never reached), then asserts the security half: cross-site refresh
403, host-suffix look-alike 403, anonymous `/api/me` 401, forged bearer 401, and
`logout` from the served origin 200 followed by 401 on the revoked cookie.

`apps/api/test/unit/origin-gate.test.ts`
— the pure decision (configured / same-host / cross-site / look-alike / port /
malformed / trailing slash) plus `wsOriginAllowed` sharing it under env drift.

Fail-before / pass-after was executed, not argued: with the fix stashed back to
`075e8a6` the suite reports

```
× login → refresh → /api/me → /api/lessons/active all survive the drift
  AssertionError: same-origin refresh must never be 403 (this was the logout trigger):
                  expected 403 not to be 403
× logout from the served origin works too … expected 403 to be 200
× wsOriginAllowed shares the same decision … expected false to be true
Tests  3 failed | 10 passed (13)
```

and with the fix applied the same files are green.

## 9. Test Results

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` | green (shared, web, api) |
| API suite (`with-postgres.mjs vitest run`) | **285 passed / 48 files (0 failed, 0 skipped)** — baseline was 272/46, so +13 tests and +2 files; nothing deleted, skipped or weakened |
| e2e with real RTC (`npx playwright test`, LiveKit Cloud env loaded) | **41 passed, 0 skipped (4.2 m)** — includes `zz-camera` (both participants see each other with fake devices), `zz2-moderation`, `zz4-layout`, i.e. the full `join → ticket → WS → room.connect() → media` chain |
| e2e without RTC env (same command, no LiveKit vars) | 38 passed, 3 skipped — the RTC specs self-skip by design when the media server is unreachable; the 3 are the RTC ones |
| `pnpm -r build` | green; `apps/api/dist` contains `lib/origin.js` and `0020_rls_app_policies.sql`, web bundle rebuilt |
| Adjacent CSRF/WS suites re-run after the gate was hardened | `origin-gate` + `video-lesson-origin-drift` + `stage7` + `phase1-hardening` + `phase1-adversarial` = **43 passed / 5 files** |
| Security half of the flow | cross-site refresh/logout 403, cross-site WS upgrade 4403, anonymous `/api/me` 401, forged bearer 401, revoked-cookie refresh 401 — all asserted |

## 10. Production Verification

**Not yet performed — and it cannot be performed by me.** Deploys are started manually
by the owner (`render.yaml` has `autoDeploy: false`, standing instruction «Деплой на
Render я запускаю вручную»), and the production service right now still runs
`075e8a6`, which is the *broken* code. The last verified production fact is therefore
the failure itself: `POST /api/auth/refresh` with the site's own origin → **403**.

The moment `overnight` (this commit) is deployed, two checks settle it:

```
curl -i -X POST https://blublu-api.onrender.com/api/auth/refresh \
     -H "Origin: https://blublu-api.onrender.com"
```
→ must now be **401 `{"error":"unauthorized"}`** (missing cookie) instead of 403. This
single status is the proof that the Origin gate stopped rejecting the deployed page.

```
node apps/e2e/scripts/cloud-call-repro.mjs <cloud.env>
```
→ expects `POST /api/auth/refresh 200`, `start-lesson` clicked, `join 200`,
`ws OPEN`, LiveKit requests present, no `401 /api/me`, no Sign In. I will run both and
paste the actual statuses after the deploy.

Alternative without a code deploy: set `PUBLIC_URL` (and/or the now-declared
`PUBLIC_WEB_ORIGIN`) in the Render dashboard to `https://blublu-api.onrender.com` and
restart — that makes the *old* code accept the real origin too. It is a workaround for
the same defect, not a fix: any future host change (custom domain, tunnel) breaks it
again, which is exactly what this commit removes.

## 11. Git Commit

Branch `overnight`, on top of `075e8a6` (history not squashed, no force-push):

```
fix: resolve video lesson production regression
```

SHA and CI run id are reported in the final response after push.
