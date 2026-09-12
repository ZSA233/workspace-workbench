.PHONY: test typecheck plugin-test plugin-typecheck package plugin-package check

test:
	PYTHONPATH=src python -m unittest discover -s tests -v

typecheck:
	$(MAKE) plugin-typecheck

plugin-typecheck:
	npm --prefix paseo-plugin run typecheck

plugin-test:
	npm --prefix paseo-plugin test

plugin-package:
	mkdir -p dist
	python scripts/package_plugin.py --output-dir dist

package: plugin-package
	python -m build --outdir dist

check: test plugin-typecheck plugin-test
