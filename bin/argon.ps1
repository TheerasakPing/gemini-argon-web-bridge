$scriptPath = Join-Path $HOME '.gemini/config/skills/argon/scripts/gemini_argon_bridge.py'
$env:ARGON_STREAM = '1'
if (Get-Command python3 -ErrorAction SilentlyContinue) {
    & python3 $scriptPath @args
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $scriptPath @args
} else {
    & python $scriptPath @args
}
exit $LASTEXITCODE
