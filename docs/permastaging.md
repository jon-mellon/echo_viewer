# Permanent preview branch

The `permastaging` branch is an isolated experimental line. It contains the
paper-review extension; it is not merged into `staging` or `main`.

- Source: `jon-mellon/echo_viewer`, branch `permastaging`.
- Hosting: `jon-mellon/echo_viewer_permastaging`, branch `main`.
- Preview: <https://www.jonathanmellon.com/echo_viewer_permastaging/>.
- Extension installation: <https://www.jonathanmellon.com/echo_viewer_permastaging/extension.html>.

Pushing `permastaging` runs **Deploy Echo Permastaging**. It tests/builds the
preview and extension, rewrites asset paths to `/echo_viewer_permastaging`, and
pushes only to the dedicated hosting repository. The existing
`STAGING_REPO_TOKEN` credential is reused if it has permission to that repository;
no token is stored in source. Deployment is restricted to the permastaging ref,
including manual dispatch. Normal staging deploys independently and does not
include the extension. The preview's web origin remains an already allowed
`www.jonathanmellon.com` origin.

## Merge isolation

GitHub ruleset **Reject permastaging promotion** requires the `profile` check
from the GitHub Actions app (15368) on exactly `staging` and `main`, with no
bypass actors. On permanent-preview descendants that check fails immediately
because their history contains the isolation root:

```
e05fbe0b8e51447b92ec4ed0123a3c42bc6d0a0c
```

The check uses Git ancestry, not only a branch name, so normal merge, squash and
rebase PRs from permastaging or a branch created from it cannot pass. It does
not execute preview application code. Ordinary release PRs use their existing
profile workflow and remain eligible to pass. The superseded feature PR #144
is closed. A second active ruleset prevents deleting or force-pushing
`permastaging`, preserving its isolation history.

The versioned rule payloads are in `.github/rulesets/`; they are **also installed
in GitHub settings**. JSON files alone do not enforce repository rules. Repository
administrators can deliberately change settings, and someone could intentionally
copy/cherry-pick code and remove the guard. This protects the normal promotion
workflow, not against an administrator deliberately undoing isolation.

Bring stable changes from staging into permastaging when needed. Do not merge
in the other direction, remove the guard from the preview profile workflow, or
rewrite the isolation root out of its history. `[permastaging-only]` in preview
commit messages is a human reminder; enforcement uses the required profile check,
not commit-message metadata rules (GitHub rejected that rule type here).

The separate preview is public, not an invitation-only environment. User-owned
OpenRouter keys are still required, and live real-paper evaluation remains
unverified.
