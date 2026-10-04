# Echo Viewer

The static viewer is deployed to [echo.epistemicinfra.org](https://echo.epistemicinfra.org) with GitHub Pages.

The deployable website is contained in `site/`. GitHub Pages uploads only that
directory, so repository-level files such as tests are not served publicly.

To preview the site locally, run:

```sh
python3 -m http.server --directory site
```

## Performance profiling

Run `npm run profile` to start a local preview and exercise startup, variable
definition and map zoom, group search, IV/DV selection, DAG layout changes,
DAG zoom, and the causal filter in Chromium.
Run `PROFILE_DEVICE=mobile npm run profile` for the same flows at a 390-pixel
viewport with 4× CPU throttling. Both suites run on every pull request and
before a GitHub Pages deployment.
The run writes `profile-results/summary.json`, a Chrome CPU profile, and a
Playwright trace. Open the CPU profile in Chrome DevTools Performance and the
trace with `npx playwright show-trace profile-results/playwright-trace.zip`.
The same run executes on pull requests and every Monday in GitHub Actions;
download its `viewer-profile` artifact to compare runs. Set `PROFILE_URL` to
profile another deployment. Only profile a deployment where you have access;
the script uses the preview's session gate and does not submit a password.
The run fails if a profiled interaction exceeds its scenario budget, an
interaction produces a long task or slow input event, or startup exceeds its
visibility, largest paint, schema readiness, long task, transfer, or layout
shift budget. Mobile budgets account for 4× CPU throttling. Use
`PROFILE_DISABLE_BUDGETS=1` for a diagnostic run without those gates.

The suite uses synthetic browser sessions only. It does not collect viewer
analytics or retain user activity.
