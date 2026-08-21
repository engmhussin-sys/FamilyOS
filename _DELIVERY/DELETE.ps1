# One stale file, left behind when scripts/verify_doctor_parity.py was renamed.
# Nothing references it any more. Run from the project root.
@(
  "scripts\verify_doctor_parity.py"
) | ForEach-Object {
  if (Test-Path $_) { Remove-Item $_ -Force; "removed : $_" }
  else { "absent (fine) : $_" }
}
