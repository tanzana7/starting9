// This bootstrap is deliberately fixed. Test Pages replaces this asset at build time;
// production never selects a team from a URL, account, cookie, or API payload.
window.Starting9TargetTeam = window.Starting9TeamContext.FIGHTERS;
window.Starting9TeamContext.applyBranding(document.documentElement, window.Starting9TargetTeam);
