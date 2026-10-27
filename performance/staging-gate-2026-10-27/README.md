# Staging diagnostic gate

The staging deployment for `4a3f8ff` passed its tests and build but failed the new mobile diagnostic-switching gate: the second exclusion switch recorded a 107 ms long task against the existing 100 ms limit. The [CI run](https://github.com/jon-mellon/echo_viewer/actions/runs/40471524988) retained a CPU profile; its sampled work identified repeated assignment-coverage scans during graph-only filter changes.

Graph filtering does not change loaded variable membership, UOA, or assignment, so that update now refreshes the filter controls without recalculating variable coverage. Normal renders still recalculate it. The coverage function also avoids scanning group memberships when no variable coordinates are loaded and avoids materializing a flattened membership array when they are. Focused tests verify both the filter-only update and assignment/UOA/overlap counts.

The exact clean candidate, including the current committed staging HEAD and this change but excluding unrelated in-progress files, passed `npm test`, a staging-configured build, and all three runs of the mobile diagnostic gate locally with the original 500 ms wall and 100 ms task limits. `ci-failure.json` contains the initial CI result and `local.json` the clean candidate run. Local CPU timings are not directly comparable with GitHub's runner; the next CI deployment remains the authoritative check.

A subsequent staging commit added a direct definition-validation text mutation in the workflow controller. This violated the repository's presentation boundary, so the same update was moved to the existing presenter; the behavior remains covered by the definition browser test.
