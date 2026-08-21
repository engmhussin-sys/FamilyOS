# Removals for: HEAD~2..HEAD
# Run from the project root BEFORE extracting the zip.
@(
  ".dockerignore",
  "railway.json"
) | ForEach-Object {
  if (Test-Path $_) { Remove-Item $_ -Force; "removed : $_" }
  else { "absent (fine) : $_" }
}
