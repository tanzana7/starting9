import { handleSimulatedNpbRequest } from "./source.js";
import { TEST_TEAMS, TEST_TEAM_GROUPS } from "./teams.js";

export async function onRequest(context) {
  try {
    return await handleSimulatedNpbRequest(context.request, context.env, { TEST_TEAMS, TEST_TEAM_GROUPS });
  } catch (error) {
    console.error(`[SIMU_NPB] code=${error?.code || "SOURCE_HANDLER_FAILED"}`);
    return Response.json({ ok: false, code: "SIMULATED_SOURCE_UNAVAILABLE" }, {
      status: 500,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
