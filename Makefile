PORT ?= 8767

.PHONY: preview

## Serve the static site locally (password: 12345), replacing any running preview
preview:
	@# The [h] keeps pkill from matching this recipe's own shell.
	@pkill -f "[h]ttp.server $(PORT)" && echo "Stopped existing preview on port $(PORT)" && sleep 0.5 || true
	@echo "Serving site/ at http://127.0.0.1:$(PORT)/  (Ctrl+C to stop)"
	python3 -m http.server $(PORT) --bind 127.0.0.1 --directory site
