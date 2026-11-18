# DSH Market index

This directory contains a format-1 DSH plugin index for `dsh-project-board`.

## Publish checklist

1. **Make the repository public.** A private GitHub repository cannot be installed by other users through DSH's Git source. In GitHub: Settings → General → Danger Zone → Change repository visibility → Public (or create a public mirror).
2. **Enable GitHub Pages** for this repository: Settings → Pages → Source: `Deploy from a branch` → branch `main`, folder `/ (root)`. The index then lives at:
   `https://kquer.github.io/dsh-project-board/market/index.json`
3. **Update `versions[].source.commit`** whenever a new release is published. Use the full 40-character SHA of the code commit (not the index commit). Bump `version`, `publishTimestamp` and `CHANGELOG.md`.
4. **Add the index in DSH:** Plugins → Discover → Index sources → add the URL above. Install from the entry.

If GitHub Pages is unreachable for your users, host this `index.json` on any public HTTPS static host (Cloudflare Pages, Vercel, Gitee Pages, an object store). The source URL still points to the Git repository, so users need access to that repository.

## Notes

- The npm name `dsh-project-board` is already taken by another package. This index uses the Git source, not npm. If you later publish to npm, use a scoped name such as `@kquer/dsh-project-board` and change both `package.json` and the entry name.
- `icon` points at GitHub Pages. Keep `icon.svg` at the repository root.
- A private repository can still be used by a **private/team** index if every user has Git credentials, but it is not a public Market entry.
