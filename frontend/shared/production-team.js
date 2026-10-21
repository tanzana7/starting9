(() => {
  const context = window.Starting9TeamContext;
  if (!context) throw new Error("Team context is unavailable");

  const teams = context.NPB_TEAMS;
  const route = window.location.pathname.match(/^\/teams\/([a-z][a-z0-9-]*)\/?$/);
  const routeTeam = route
    ? Object.values(teams).find((team) => team.slug === route[1])
    : null;
  const queryTeam = new URLSearchParams(window.location.search).get("team");
  const requestedTeam = route ? routeTeam : queryTeam ? teams[queryTeam] : teams.fighters;

  if (!requestedTeam) {
    window.Starting9TargetTeam = null;
    document.body.replaceChildren(Object.assign(document.createElement("main"), {
      className: "team-route-error",
      textContent: "球団ページが見つかりません。"
    }));
    document.documentElement.dataset.teamRouteError = "true";
    return;
  }

  window.Starting9TargetTeam = requestedTeam;
  document.documentElement.dataset.team = requestedTeam.key;
  context.applyBranding(document.documentElement, requestedTeam);
  // Public Fighters keeps its shipped, slightly darker display palette. Other teams receive
  // their canonical Team Context colors on the body, where the legacy public palette is scoped.
  if (document.body) {
    document.body.dataset.team = requestedTeam.key;
    if (requestedTeam.key !== "fighters") context.applyBranding(document.body, requestedTeam);
  }
  document.title = `Starting9 | ${requestedTeam.shortName}のスタメン予想`;
  const description = document.querySelector('meta[name="description"]');
  const pageDescription = `Starting9で${requestedTeam.displayName}のスタメンを予想。試合後は採点やランキングを確認できます。`;
  if (description) description.content = pageDescription;
  for (const [selector, content] of [
    ['meta[property="og:title"]', document.title],
    ['meta[property="og:description"]', pageDescription],
    ['meta[name="twitter:title"]', document.title],
    ['meta[name="twitter:description"]', pageDescription]
  ]) {
    const meta = document.querySelector(selector);
    if (meta) meta.content = content;
  }

  const host = document.querySelector(".header-inner, .admin-v3-header");
  if (!host || document.getElementById("productionTeamSelector")) return;
  const navigation = document.createElement("nav");
  navigation.className = "production-team-navigation";
  navigation.setAttribute("aria-label", "球団");
  const label = document.createElement("label");
  label.htmlFor = "productionTeamSelector";
  label.textContent = "球団";
  const selector = document.createElement("select");
  selector.id = "productionTeamSelector";
  for (const team of Object.values(teams)) {
    const option = document.createElement("option");
    option.value = team.key;
    option.textContent = team.displayName;
    option.selected = team.key === requestedTeam.key;
    selector.append(option);
  }
  selector.addEventListener("change", () => {
    const team = teams[selector.value];
    if (!team) return;
    if (window.location.pathname === "/admin-v3.html") {
      const url = new URL(window.location.href);
      if (team.key === "fighters") url.searchParams.delete("team");
      else url.searchParams.set("team", team.key);
      window.location.assign(url.href);
      return;
    }
    window.location.assign(team.key === "fighters" ? "/" : `/teams/${team.slug}/`);
  });
  navigation.append(label, selector);
  host.prepend(navigation);
})();
