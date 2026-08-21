#!/usr/bin/env bash
# Removals for: HEAD~1..HEAD
# Run from the project root BEFORE extracting the zip.
set -u
for f in \
  "scripts/verify_doctor_parity.py" \
  ; do
  if [ -f "$f" ]; then rm -f "$f"; echo "removed : $f"; else echo "absent (fine) : $f"; fi
done
