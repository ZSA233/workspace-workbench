# Releasing Workspace Workbench

Workspace Workbench uses stable `MAJOR.MINOR.PATCH` versions. The root
`VERSION` file is the source of truth; the Python package, Paseo package and
lockfile are checked against it.

## Bump and verify

Choose the smallest change that describes the public compatibility impact:

```sh
make bump-patch   # bug fix, no intended API break
make bump-minor   # compatible feature
make bump-major   # breaking public contract
make check
make release-check TAG=v0.1.1
```

The bump commands only edit version metadata. They do not create commits,
tags, releases or remote changes. Review the diff and update release notes
before committing.

## Publish a release

```sh
git add VERSION pyproject.toml src/workspace_workbench/__init__.py \
  paseo-plugin/package.json paseo-plugin/package-lock.json
git commit -m "chore(release): v0.1.1"
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main v0.1.1
```

The release workflow checks out the tag, runs the full test/build pipeline,
publishes Python and Paseo attachments with `SHA256SUMS`, and then advances
the `stable` branch to the tested tag commit. It never publishes to PyPI or
npm. A manually dispatched release must name an existing tag and must pass the
same version check.

Do not reuse a published version. If a release fails after the tag exists,
fix the source in a new version and create a new tag.

## Install and update the Paseo plugin

Replace `OWNER` with the GitHub account or organization that owns the public
repository. Paseo v0.8 supports Git-managed plugin sources:

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

The `stable` channel follows the latest tested release. The `edge` channel
follows the default development branch:

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref main \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

`paseo plugin update` is an explicit fetch/build/validate/activate operation;
it is not a background updater. The plugin listing shows its Git source, ref
and commit:

```sh
paseo plugin ls workspace-workbench-paseo --json
```

The plugin manifest runs `npm ci` with the committed lockfile and then
typechecks the checkout before Paseo activates it. This is a trusted plugin
operation: Paseo runs plugin build commands on the daemon host, so install only
from a repository you trust.

For a fixed version, use the `vX.Y.Z` ref or the matching GitHub Release
archive. A fixed tag is intentionally immutable and does not advance through
`paseo plugin update`; switch it explicitly when upgrading.

## Release assets

The GitHub Release also contains a Python wheel, source distribution, a
`workspace-workbench-paseo-VERSION.tar.gz` archive and checksums. Use these
assets for offline installation, reviewable artifact pinning or environments
where Git access is unavailable. The archive does not contain project JSON,
SQLite data, sockets, Agent bindings or secrets.
