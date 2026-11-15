# Permanent preview isolation

`permastaging` contains experimental features and deploys only to the separate
`echo_viewer_permastaging` hosting repository. Never merge it or branches based
on it into `staging` or `main`. Keep the `[permastaging-only]` isolation marker
in its history; the required GitHub profile check rejects that history from both release branches.
Bring changes from staging into permastaging when needed, never the reverse.

# Pull requests

Open pull requests from feature branches against `staging` initially. Pull requests targeting `main` must come from `staging`.
