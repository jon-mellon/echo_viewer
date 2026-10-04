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
viewport with 4× CPU throttling. Run `PROFILE_BROWSER=firefox npm run profile`
to check the same interactions in Firefox. All three suites run on every pull
request and before a GitHub Pages deployment.
Each run writes a summary and Playwright trace to its browser-specific results
directory. Chromium also writes a CPU profile. Open that profile in Chrome
DevTools Performance, or inspect a trace with
`npx playwright show-trace profile-results/playwright-trace.zip`.
The suites also run every Monday in GitHub Actions; download the one-day
`viewer-profile` artifact to inspect a failing synthetic run. Set `PROFILE_URL` to
profile another deployment. Only profile a deployment where you have access;
the script uses the preview's session gate and does not submit a password.
The scenarios include the edge inspector's Hide action and verify that the edge
disappears promptly, then that the graph finishes updating. The run fails if a
profiled interaction exceeds its scenario budget, an
interaction produces a long task or slow input event, or startup exceeds its
visibility, largest paint, schema readiness, long task, transfer, or layout
shift budget. Schema readiness is capped at 8 seconds on desktop and the
membership wait after the first paint at 4 seconds. Mobile budgets account for
4× CPU throttling. Firefox enforces interaction and readiness times; browser
metrics unsupported by Firefox are reported as unavailable. Use
`PROFILE_DISABLE_BUDGETS=1` for a diagnostic run without those gates.

The suite uses synthetic browser sessions only. It does not collect viewer
analytics or retain user activity.
