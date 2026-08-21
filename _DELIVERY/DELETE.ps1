# Removals for: HEAD~1..HEAD
# Run from the project root BEFORE extracting the zip.
@(
  "scripts\verify_doctor_parity.py"
) | ForEach-Object {
  if (Test-Path $_) { Remove-Item $_ -Force; "removed : $_" }
  else { "absent (fine) : $_" }
}
