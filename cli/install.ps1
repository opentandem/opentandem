# OpenTandem installer for Windows. Node.js does not need to be installed.
#   irm https://opentandem.org/install.ps1 | iex; opentandem remote
#   & ([scriptblock]::Create((irm https://opentandem.org/install.ps1))) connect --key <key>
# Installs the pinned Node.js runtime (checked against a pinned sha256), the launcher and the `opentandem` command.
# The launcher keeps the CLI and the Runner up to date.
$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
$Server = '__SERVER_ORIGIN__'
$NodeVersion = '__NODE_VERSION__'
# Same language rule as the CLI: the system display language.
$Zh = (Get-UICulture).TwoLetterISOLanguageName -eq 'zh'
function Say([string]$En, [string]$ZhText) { if ($Zh) { Write-Host $ZhText } else { Write-Host $En } }
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$NodeSha = @{ x64 = '__SHA_WIN32_X64__'; arm64 = '__SHA_WIN32_ARM64__' }[$Arch]
$Uri = [Uri]$Server
$Instance = $Uri.Host + $(if ($Uri.IsDefaultPort) { '' } else { '_' + $Uri.Port })
$Root = Join-Path $env:LOCALAPPDATA 'OpenTandem'
$InstanceDir = Join-Path $Root $Instance
$RuntimeDir = Join-Path $Root "runtime\node-v$NodeVersion-win32-$Arch"
$Node = Join-Path $RuntimeDir 'node.exe'
New-Item -ItemType Directory -Force $InstanceDir, (Join-Path $Root 'runtime') | Out-Null

if (-not (Test-Path $Node)) {
  Say '→ Downloading the Node.js runtime (one time, about 30 MB)…' '→ 正在下载 Node.js 运行环境（只需一次，约 30 MB）…'
  $Stage = Join-Path $Root ('runtime\.stage-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Force $Stage | Out-Null
  try {
    $Archive = Join-Path $Stage 'node.zip'
    # The mirror first, then nodejs.org; both are checked against the same pinned sha256 below.
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/runner-runtime/$Arch`?platform=win32" -OutFile $Archive }
    catch { Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$Arch.zip" -OutFile $Archive }
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower() -ne $NodeSha) { throw 'Node.js checksum mismatch. Installation stopped.' }
    # Extract straight into place: Windows refuses to move a folder of freshly extracted programs
    # while antivirus software is still scanning them ("Access to the path ... is denied").
    if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
    New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
    tar.exe -xf $Archive -C $RuntimeDir --strip-components=1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Node)) {
      Remove-Item -Recurse -Force $RuntimeDir -ErrorAction SilentlyContinue
      throw 'Cannot extract Node.js.'
    }
  } finally { Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue }
}

$Launcher = Join-Path $InstanceDir 'launcher.mjs'
# The temporary copy keeps the .mjs extension: `node --check` refuses unknown extensions.
$Next = Join-Path $InstanceDir 'launcher.next.mjs'
Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/cli-script?file=launcher.mjs" -OutFile $Next
& $Node --check $Next
if ($LASTEXITCODE -ne 0) { throw 'Cannot download OpenTandem. Check your network and try again.' }
Move-Item -Force $Next $Launcher

$Bin = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force $Bin | Out-Null
$Cmd = "@setlocal`r`n@if not defined OPENTANDEM_SERVER set `"OPENTANDEM_SERVER=$Server`"`r`n@`"$Node`" `"$Launcher`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $Bin 'opentandem.cmd'), $Cmd)
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $Bin)) {
  [Environment]::SetEnvironmentVariable('Path', $(if ($UserPath) { "$UserPath;$Bin" } else { $Bin }), 'User')
}
if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }
# With arguments (a script block created from this file), run that command right away; `irm | iex` passes none.
# No `exit` here: inside a script block it would close the caller's PowerShell window. The exit code stays in $LASTEXITCODE.
if ($args.Count -gt 0) { $env:OPENTANDEM_SERVER = $Server; & $Node $Launcher @args } else { Say 'OpenTandem is installed. Next, run: opentandem remote' 'OpenTandem 已安装。下一步运行：opentandem remote' }
