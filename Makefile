.PHONY: test typecheck plugin-test plugin-typecheck backend package plugin-package check \
	version-check bump-patch bump-minor bump-major release-check

version-check:
	python scripts/version.py --check

bump-patch:
	python scripts/version.py --bump patch

bump-minor:
	python scripts/version.py --bump minor

bump-major:
	python scripts/version.py --bump major

test:
	PYTHONPATH=src python -m unittest discover -s tests -v

typecheck:
	$(MAKE) plugin-typecheck

plugin-typecheck:
	npm --prefix paseo-plugin run typecheck

plugin-test:
	npm --prefix paseo-plugin test

backend:
	python scripts/build_backend.py

plugin-package: version-check
	mkdir -p dist
	python scripts/package_plugin.py --output-dir dist

package: plugin-package
	python -m build --outdir dist

release-check:
	@test -n "$(TAG)" || { echo "usage: make release-check TAG=vX.Y.Z" >&2; exit 2; }
	python scripts/version.py --check --tag "$(TAG)"

check: version-check test plugin-typecheck plugin-test
