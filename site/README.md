# Whale website

The public site for mywhalewallet.com: the landing page (`index.html`) and the docs page (`docs/index.html`). It is plain HTML and CSS with one small script, `site.js`, for the copy buttons, the host picker and the docs chapter highlight. There is no build step and no dependency. The design source is `../design/whale.pen`, and `../design/README.md` lists the code behind each claim on the page.

## Preview

```sh
cd site
python3 -m http.server 8080
```

Open http://localhost:8080. The Python server does not send the headers in `_headers`, so it does not test the Content-Security-Policy.

## Deploy

Create a Cloudflare Pages project connected to this repository, with these build settings:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | (empty) |
| Build output directory | `site` |

Pages serves the folder as it is and reads `_headers` for the security headers. The dashboard is a separate app at app.mywhalewallet.com and is not part of this folder.

## Edit the copy

Every claim must match the code on `main`. Change `../design/README.md` in the same PR, and change both pages when a shared block changes: the install block, the comparison table and the Known issues block appear in `index.html` and in `docs/index.html`. Code links point at a fixed commit, so update the commit and the line numbers together.

## Third-party files

- `fonts/`: Geist and Geist Mono 1.9.2 from github.com/vercel/geist-font, under the SIL Open Font License (`fonts/OFL.txt`).
- `assets/icons.svg`: icons from Phosphor Icons 2.1.1, under the MIT License (`assets/icons-LICENSE.txt`).
- `assets/logos/`: copied from `../design/logos`. See "Logo sources" in `../design/README.md`.
- `assets/whale-sketch.png`: the hero drawing, cut from `../design/exports/landing-desktop.png`.
