// Compatibility facade. Existing Worker and test imports remain stable while
// V3 automation responsibilities live in focused backend/automation-v3 modules.
export * from "./backend/automation-v3/constants.js";
export * from "./backend/automation-v3/domain.js";
export * from "./backend/automation-v3/lineup-artifacts.js";
export * from "./backend/automation-v3/probable-starter-planner.js";
export * from "./backend/automation-v3/roster-repository.js";
export * from "./backend/automation-v3/planner.js";
export * from "./backend/automation-v3/repository.js";
export * from "./backend/automation-v3/orchestrator.js";
export * from "./backend/automation-v3/executor.js";
export * from "./backend/automation-v3/audit.js";
export * from "./backend/automation-v3/diagnostics.js";
