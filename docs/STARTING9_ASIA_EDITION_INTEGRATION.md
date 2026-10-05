# Starting9 Asia Edition integration

## Edition window

`frontend/shared/edition-config.js` is the single deployment configuration for
the public and admin default edition. `frontend/shared/edition.js` resolves the
window in `Asia/Tokyo` using an inclusive start and exclusive end:

`activeFrom <= now < activeUntil`

Both values remain empty until the release window is explicitly approved. An
empty or invalid window always resolves to NPB; competition status does not
implicitly switch the whole product. `?edition=npb` and `?edition=asia` are
explicit user/admin selections and are not persisted in local storage.

## Authentication boundary

Same-origin `/api/asia-cs/*` requests go to the existing Auth Worker first.
The Auth Worker verifies `s9_session` against the existing Starting9 identity,
then forwards the request to `starting9-asia-cs-api` with a short-lived,
method/path-bound HMAC assertion. Asia Worker accepts that assertion only when
`ASIA_CS_AUTH_BRIDGE_SECRET` is present and valid; client-supplied identity
headers are never trusted. The existing direct-worker auth fallback remains
only for compatibility with the legacy explicit URL and should be removed
after the gateway is live and verified.

The same bridge serves public prediction ownership and admin mutations. It does
not create a second login, password, JWT, or browser admin token. Before
production deployment, set the same randomly generated secret value in both
Workers without committing it or displaying it. Do not use a dummy value.

## Compatibility URLs

`/asia-cs/` remains the explicit public compatibility URL. `/asia-cs/admin`
redirects to `/admin-v3.html?edition=asia`; the inline admin tab is the
supported operation path.
