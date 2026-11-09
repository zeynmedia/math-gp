# Puts the YouTube stream key into the math-gp repo secrets. Typed here, never written to disk.
$k = Read-Host "YouTube Studio > Go Live > Stream > Stream key: yapistir ve Enter"
if ($k.Trim()) { $k.Trim() | gh secret set LIVE_STREAM_KEY -R zeynmedia/math-gp; Write-Host "Tamam, pencereyi kapatabilirsin." -ForegroundColor Green }
