PORT ?= 8767

.PHONY: preview

## Serve the static site locally (password: 12345), uncached, replacing any running preview
preview:
	@# The [h] and [p] keep pkill from matching this recipe's own shell.
	@pkill -f "[h]ttp.server $(PORT)|[p]review_server.py $(PORT)" && echo "Stopped existing preview on port $(PORT)" && sleep 0.5 || true
	@echo "Serving site/ at http://127.0.0.1:$(PORT)/  (Ctrl+C to stop)"
	python3 scripts/preview_server.py $(PORT)
