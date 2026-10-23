(() => {
  const context = window.Starting9TeamContext;
  if (!context) throw new Error("Test Site Team Context is unavailable");

  const teams = context.NPB_TEAMS;
  const routeSlug = window.location.pathname.match(/^\/teams\/([a-z-]+)\/?$/)?.[1] || "";
  const routeTeam = Object.values(teams).find((team) => team.slug === routeSlug);
  const queryTeam = new URLSearchParams(window.location.search).get("team");
  const requestedTeam = routeTeam || (queryTeam ? teams[queryTeam] : teams.fighters);
  if (!requestedTeam) throw new Error("Unknown Test Site team route");

  // This cookie opts only the test Pages proxy into the isolated synthetic NPB
  // source; the production team selector remains the sole team-switching UI.
  document.cookie = `s9_test_team=${requestedTeam.key}; Path=/; SameSite=Lax; Secure`;
  document.cookie = "s9_test_source=simu-npb; Path=/; SameSite=Lax; Secure";
})();
