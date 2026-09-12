.PHONY: test typecheck check

test:
	PYTHONPATH=src python -m unittest discover -s tests -v

typecheck:
	npm --prefix paseo-plugin run typecheck

check: test typecheck
