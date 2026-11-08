// Settings and agent-facing rules for the optional confounder-status checks.
// Both are off unless the MCP server is started with the environment variable set.
const enabled = name => ["1", "true"].includes(String(process.env[name] || "").toLowerCase());

/** ECHO_CHECK_ONLY_VIA: challenge "causes_y_only_via_x" against the graph. */
export const checkOnlyViaEnabled = () => enabled("ECHO_CHECK_ONLY_VIA");
/** ECHO_CHECK_ADJUSTMENT: challenge "not_in_minimal_adjustment_set" against the graph. */
export const checkAdjustmentEnabled = () => enabled("ECHO_CHECK_ADJUSTMENT");

/** Name used in `rejectedPaths` for a direct confounder → outcome link. */
export const DIRECT_PATH = "direct";
/** Longest directed arm, in links, searched from the confounder to the IV or to the DV. */
export const MAX_ARM_LENGTH = 3;

export const ONLY_VIA_RULES = [
  "causes_y_only_via_x claims that the confounder (K) reaches the outcome (Y) only through the IV (X).",
  "The check looks at the graph's current links, using any link with at least one supporting paper, for two kinds of route that bypass X: a direct link K → Y, and K → Z → Y for any other group Z. Longer routes are not searched, so passing the check does not prove the claim.",
  `If any are found the call is refused and lists them. To proceed, repeat the call with rejectedPaths naming every listed route (Z's group ID, or "${DIRECT_PATH}" for K → Y) and with text explaining, for each route, which link you judge not to be a real causal effect of K on Y and why (for example a mis-grouped variable or a finding that does not support the direction).`,
  "rejectedPaths may contain only routes the check listed. Rejecting a route does not change the graph; if you want a link to stop counting, also exclude it with echo_set_edge_decision or echo_set_finding_decision. If you cannot justify rejecting a route, choose a different status.",
];

export const ADJUSTMENT_RULES = [
  "not_in_minimal_adjustment_set claims that adjusting for the confounder (K) is unnecessary because the other adjusted-for groups already close every backdoor path between the IV (X) and the outcome (Y) that runs through K.",
  `Adjusted-for groups are those whose status for this IV and DV is explicitly_controlled or accounted_for_by_design; K itself and unaddressed or other candidates do not count.`,
  `The check looks for an open route: a directed arm K → … → X and a directed arm K → … → Y, each at most ${MAX_ARM_LENGTH} links long, that share no group except K, contain no adjusted-for group, and where neither arm passes through X or Y (X ← … ← K → … → Y). Such a route is a backdoor path nothing adjusted for blocks. Longer arms are not searched, so passing the check does not prove the claim.`,
  "If any open route is found the call is refused and lists up to five, shortest first. To proceed, repeat the call with text that covers each listed route: either name the group that will block it and set that group's status to explicitly_controlled or accounted_for_by_design, or say which link on the route you judge not to be a real causal effect and why. Where the blocker is another group on the route, that group must be adjusted for, not just named.",
  "text is stored with the status and kept private; the check only requires that it is not empty, so write it for the human who reviews the decision. If you cannot justify the claim, choose a different status such as explicitly_controlled.",
];

const section = (title, rules) => `${title}\n${rules.map(rule => `- ${rule}`).join("\n")}`;

/** The rules for each check that is switched on, for the MCP initialize response. Empty when none is. */
export function checkInstructions() {
  return [checkOnlyViaEnabled() && section("causes_y_only_via_x is checked (ECHO_CHECK_ONLY_VIA):", ONLY_VIA_RULES),
    checkAdjustmentEnabled() && section("not_in_minimal_adjustment_set is checked (ECHO_CHECK_ADJUSTMENT):", ADJUSTMENT_RULES)]
    .filter(Boolean).join("\n\n");
}

/** Tool-description text; unlike checkInstructions it is always present so the rules are visible before a refusal. */
export const CHECK_TOOL_NOTE = `Optional checks, enabled by environment variable on the MCP server. `
  + `ECHO_CHECK_ONLY_VIA: causes_y_only_via_x is refused while the graph holds a direct link from the confounder to the outcome, `
  + `or a confounder → z → outcome route through another group, unless rejectedPaths names each one (z's group ID, or "${DIRECT_PATH}") and text explains why each is not a real effect. `
  + `ECHO_CHECK_ADJUSTMENT: not_in_minimal_adjustment_set is refused while the confounder has separate routes to the IV and to the outcome `
  + `(each up to ${MAX_ARM_LENGTH} links, sharing no group, through no group whose status is explicitly_controlled or accounted_for_by_design) that nothing adjusted for blocks, `
  + `unless text says which group blocks each route or why it is not a real causal path.`;
