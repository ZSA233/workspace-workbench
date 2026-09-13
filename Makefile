.PHONY: test typecheck plugin-test plugin-typecheck backend package plugin-package check \
	version-check bump-patch bump-minor bump-major release-check

version-check:
	node scripts/version.mjs --check

bump-patch:
	node scripts/version.mjs --bump patch

bump-minor:
	node scripts/version.mjs --bump minor

bump-major:
	node scripts/version.mjs --bump major

test:
	$(MAKE) plugin-test

typecheck:
	$(MAKE) plugin-typecheck

plugin-typecheck:
	npm --prefix paseo-plugin run typecheck

plugin-test:
	npm --prefix paseo-plugin test

backend:
	npm --prefix paseo-plugin run typecheck

plugin-package: version-check
	mkdir -p dist
	node scripts/package_plugin.mjs --output-dir dist

package: plugin-package

release-check:
	@test -n "$(TAG)" || { echo "usage: make release-check TAG=vX.Y.Z" >&2; exit 2; }
	node scripts/version.mjs --check --tag "$(TAG)"

check: version-check plugin-typecheck plugin-test
