#!/bin/sh
# Run before publishing: fails if anything that must not be public would be committed.
cd "$(dirname "$0")/.."
fail=0
files=$(git ls-files --cached --others --exclude-standard 2>/dev/null)
echo "$files" | grep -iE '\.(gb|gbc|sav|rom|ips|bps)$' && { echo "ERROR: ROM-like file in the publishable set"; fail=1; }
echo "$files" | grep -E '^(public/(og|favicon|apple-touch-icon)\.png|public/rom/|public/days/|public/sprites/|rom/(pokeyellow-pristine|src|work|tools)/|wrangler\.local\.toml|\.mcp\.json|CLAUDE\.md|TEMP-NOTES\.md)' && { echo "ERROR: private or generated file in the publishable set"; fail=1; }
big=$(echo "$files" | while read -r f; do [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 1500000 ] && echo "$f"; done)
[ -n "$big" ] && { echo "ERROR: large files (ROM-sized?):"; echo "$big"; fail=1; }
echo "$files" | xargs grep -lIE '/Users/|sam_stokes|BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null | grep -v '^scripts/prepublish-check.sh$' && { echo "ERROR: personal path or key in the files above"; fail=1; }
grep -q 'REPLACE_WITH_YOUR_D1_ID' wrangler.toml || { echo "ERROR: wrangler.toml has a real database_id"; fail=1; }
[ $fail -eq 0 ] && echo "prepublish check: OK ($(echo "$files" | wc -l | tr -d ' ') files would be published)"
exit $fail
