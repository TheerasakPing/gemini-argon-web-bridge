$ErrorActionPreference = 'Stop'
$taskTmp = Join-Path ([IO.Path]::GetTempPath()) ("argon-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskTmp | Out-Null
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20+ first.' }
    $archive = Join-Path $taskTmp 'argon.zip'
    Invoke-WebRequest 'https://github.com/TheerasakPing/gemini-argon-web-bridge/archive/refs/heads/main.zip' -OutFile $archive
    Expand-Archive $archive -DestinationPath $taskTmp
    $installer = Join-Path $taskTmp 'gemini-argon-web-bridge-main/scripts/install.py'
    if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 $installer @args }
    elseif (Get-Command python3 -ErrorAction SilentlyContinue) { & python3 $installer @args }
    else { & python $installer @args }
    if ($LASTEXITCODE -ne 0) { throw "Argon installer failed ($LASTEXITCODE)." }
    # Also expose the command in this PowerShell session.
    $env:Path = (Join-Path $HOME '.local/bin') + [IO.Path]::PathSeparator + $env:Path
} finally {
    Remove-Item -Recurse -Force $taskTmp
}
