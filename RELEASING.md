# Releasing

This package is published to **npm** as [`lago-x402`](https://www.npmjs.com/package/lago-x402), an unscoped package, matching Lago's other public SDKs (`lago-javascript-client`, `lago-agent-sdk`).

Releases are triggered by pushing a `v*.*.*` git tag. The publish workflow (`.github/workflows/publish.yml`):

1. Verifies the release: the repository is public, and the tag names the `X.Y.Z` version in `package.json` and a commit on `main`
2. Runs the full CI gate, the same `ci.yml` pushes and pull requests run (Node 22, 24 and 26 on Ubuntu and macOS, the package check on Node 22.12.0, and the Next.js integration)
3. Builds and packs the tarball once
4. Publishes that tarball to npm with **OIDC trusted publishing** and a sigstore **provenance** attestation, after a maintainer approves
5. Creates a GitHub Release with auto-generated notes and the same tarball

## One-time setup (before the first release)

None of this is in place yet. Do all of it before pushing the first tag.

### 1. Make the repository public

npm attaches provenance only to packages published from a public repository, and the workflow passes `--provenance` explicitly, so it never publishes without an attestation. Its `verify` job stops a run from a repository that isn't public before anything is signed: from this internal repository, npm would otherwise write the run's provenance (repository, commit, workflow, run) to the public sigstore log before the registry refused the upload.

### 2. Put the package on npm

npm can only attach a trusted publisher to a package that already exists (`npm trust`: "The package you're configuring must already exist on the npm registry"; [npm/cli#8544](https://github.com/npm/cli/issues/8544) asks to lift this), and `lago-x402` is not on npm yet, so the first version cannot come from this workflow.

Recommended: a maintainer publishes a placeholder `0.0.0` that holds no code, from their own account with two-factor authentication. `0.1.0` then comes from the workflow, with provenance, like every later version. It also reserves the name.

```bash
mkdir lago-x402-placeholder && cd lago-x402-placeholder
cat > package.json <<'EOF'
{
  "name": "lago-x402",
  "version": "0.0.0",
  "description": "Placeholder. Releases come from https://github.com/getlago/lago-x402-js",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/getlago/lago-x402-js.git" }
}
EOF
npm publish --access public   # asks for your two-factor code
```

The alternative keeps `0.1.0` as the first version: publish it from this workflow with a short-lived granular npm token, stored as a secret on the `npm` environment and given to the `Publish` step as `NODE_AUTH_TOKEN` for that one run, then delete the token and the secret and drop the step's `env`. It costs a token and a temporary workflow change.

### 3. The `npm` environment (required)

Trusted publishing is bound to the `npm` environment, so its protection rules are what stand between a pushed tag and a live npm release. Create it under **Settings → Environments → New environment** before the first tag: a workflow that names a missing environment creates it with **no** protection, and that run publishes at once. It needs no secrets; OIDC handles auth.

| Rule                                                       | Setting                                | Why                                                                                     |
| ---------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| Required reviewers                                         | Add 1+ maintainers                     | The publish job pauses for human approval before it can mint the OIDC token and upload. |
| Prevent self-review                                        | On                                     | Whoever pushed the tag cannot approve their own release.                                |
| Allow administrators to bypass configured protection rules | Off                                    | An admin account cannot skip the approval either.                                       |
| Deployment branches and tags                               | **Selected** → add a `v*.*.*` tag rule | Only version tags can deploy to `npm`.                                                  |

### 4. A ruleset for release tags (recommended)

**Settings → Rules → Rulesets → New ruleset → New tag ruleset**, targeting `v*.*.*`, with **Restrict creations**, **Restrict updates** and **Restrict deletions**, and the release maintainers on the bypass list. Only they can then push a release tag, and a released tag cannot be moved to other code.

### 5. Repository Actions settings (recommended)

Under **Settings → Actions → General** (some may be set by the organization):

- **Workflow permissions**: _Read repository contents and packages permissions_. Every workflow here declares its own permissions, but the default token is currently read and write.
- Untick **Allow GitHub Actions to create and approve pull requests**.
- Tick **Require actions to be pinned to a full-length commit SHA**. Every action here already is.

### 6. Trusted publisher on npm (when `0.1.0` is ready to tag)

On npmjs.com, **lago-x402 → Settings → Trusted publishing**:

| Field             | Value          |
| ----------------- | -------------- |
| GitHub Owner      | `getlago`      |
| Repository name   | `lago-x402-js` |
| Workflow filename | `publish.yml`  |
| Environment name  | `npm`          |

A new trusted publisher configuration must complete its first successful publish within 2 days or it expires, so add it right before tagging. npm does not check it when you save it: a mismatch shows up at publish time as `E404 Not Found`.

### After the first release

- On npm, **Settings → Publishing access → Require two-factor authentication and disallow tokens**, and revoke any automation tokens for the package. Trusted publishing keeps working (it uses OIDC, not tokens), and a leaked token can no longer publish.
- Deprecate the placeholder: `npm deprecate lago-x402@0.0.0 "Placeholder, install a released version"`.

## How the workflow is hardened

- **Least privilege.** The workflow grants nothing by default. `verify`, `ci` and `build` read the repository; `publish` gets only `id-token: write` (it checks out nothing); `release` gets only `contents: write`. No checkout persists the `GITHUB_TOKEN` in `.git`.
- **Pinned actions.** Every action is pinned to a full commit SHA, so a re-pointed tag cannot inject code into the job that mints the OIDC token. Dependabot bumps the pins, and waits until a release is a week old before proposing it.
- **Only reviewed code is released.** `verify` fails unless the tag names `package.json`'s version, a plain `X.Y.Z` (a prerelease would need its own npm dist-tag), and points at a commit on `main`, so a tag on an unmerged branch cannot release, even past an approval. The `publish` job also carries `if: startsWith(github.ref, 'refs/tags/v')`, so it refuses a non-tag ref even if the environment's tag rule is removed.
- **The release gate is CI.** `publish.yml` calls `ci.yml` itself, so a release passes every check a pull request does, and the Node versions are listed in one place.
- **No cache in a release.** `cache-mode: none` makes GitHub refuse every cache read and write in a release run, the called `ci.yml` jobs included, so a poisoned cache cannot reach what is published. `build` and `publish` also set `package-manager-cache: false`.
- **One build, no install scripts, signed dependencies.** `build` installs with `npm ci --ignore-scripts` from the committed lockfile (the build is `tsc` only), runs `npm audit signatures` so every installed package must carry a valid npm registry signature (and attestation, where it has one), builds, packs, and writes the tarball's SHA-256 to the run summary.
- **The token-minting job runs no project code.** `publish` downloads the build's tarball (the download fails on a digest mismatch) and runs `npm publish <tarball> --provenance --access public`. It checks out nothing, installs nothing and builds nothing: it runs only Node, npm and two pinned GitHub-owned actions. The provenance attestation signs the tarball's own SHA-512 and names this workflow run, so it covers a tarball packed by another job of the same run.
- **Provenance or nothing.** npm adds provenance on its own only for a public repository and would otherwise publish without it. The explicit `--provenance` makes the publish fail instead, and `verify` stops a run from a repository that isn't public before anything is signed.
- **What npm serves is what the release attaches.** `release` attaches the same tarball, without a checkout, and `gh release create --verify-tag` refuses to create the tag if it is not already on GitHub.
- **One run per tag.** Runs for the same tag never overlap, and one in progress is never cancelled midway between npm and the GitHub release.

The attestation is shown on the npm package page ("Built and signed on GitHub Actions"), linking the version to this repository, the workflow and the commit.

### Stronger still: staged publishing (not adopted yet)

npm can restrict a trusted publisher to **stage-only**: the workflow runs `npm stage publish`, and the version goes live only once a maintainer approves it on npmjs.com (or with `npm stage approve`) with two-factor authentication. A stolen OIDC token could then only reach the stage queue. It needs npm 11.15 or later. It is not used yet because npm's documentation does not say whether a staged version carries provenance. Revisit it after the first release.

## Cutting a release

Replace `X.Y.Z` below with the version you're releasing.

```bash
# 1. Check the release against a real Lago on testnet (optional, recommended):
#    see "Live test" in README.md. It spends one testnet top-up.
npm run test:live

# 2. Update the version
$EDITOR package.json                # bump the "version" field to X.Y.Z
# (or: npm version X.Y.Z --no-git-tag-version)
$EDITOR CHANGELOG.md                # move [Unreleased] under "## [X.Y.Z] - YYYY-MM-DD"

# 3. Commit on a branch, open a pull request and merge it: the tag must point
#    at a commit on main.
git switch -c release/X.Y.Z
git commit -am "chore(release): X.Y.Z"
git push -u origin release/X.Y.Z
gh pr create --fill

# 4. Tag the merged commit on main and push only that tag: this triggers the
#    publish workflow
git switch main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then approve the `publish to npm` job when it asks. Within a few minutes of the approval the package is on npm and the GitHub Release is open. Customers can then:

```bash
npm install lago-x402@X.Y.Z
```

### Verifying a release

The tarball attached to the GitHub Release is the file npm serves, so their SHA-512 digests match:

```bash
npm view lago-x402@X.Y.Z dist.integrity
gh release download vX.Y.Z --repo getlago/lago-x402-js --pattern '*.tgz'
echo "sha512-$(openssl dgst -sha512 -binary lago-x402-X.Y.Z.tgz | openssl base64 -A)"
```

In an app that installs it, `npm audit signatures` checks the version's registry signature and provenance attestation.

## If something goes wrong mid-release

- **`verify` or CI fails:** fix the failure, delete the tag, retag, push.
  ```bash
  git tag -d vX.Y.Z
  git push --delete origin vX.Y.Z
  # fix the issue, merge the fix to main
  git tag vX.Y.Z
  git push origin vX.Y.Z
  ```
- **`publish` fails** (an `E404` usually means the trusted publisher doesn't match, or expired before its first publish): fix the cause, then **Re-run failed jobs** from the GitHub Actions UI. It publishes the same tarball artifact.
- **`release` fails after npm has the version:** **Re-run failed jobs**; it attaches the same tarball.
- **A bad version is already on npm:** npm allows `npm unpublish` within 72 hours of publish. After that, you must release a fresh patch version (`v0.1.1`). Don't publish breaking changes under a patch.

## Versioning policy

Pre-1.0 we follow `0.<minor>.<patch>` where:

- `<minor>` bumps for new features or breaking changes (we're in 0.x — breakages are allowed but documented in `CHANGELOG.md`).
- `<patch>` bumps for fixes only.

Post-1.0 we follow strict [semver](https://semver.org).
