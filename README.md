# Echo Viewer

The static viewer is deployed to [echo.epistemicinfra.org](https://echo.epistemicinfra.org) with GitHub Pages.

The deployable website is contained in `site/`. GitHub Pages uploads only that
directory, so repository-level files such as tests are not served publicly.

To preview the site locally, run:

```sh
python3 -m http.server --directory site
```
