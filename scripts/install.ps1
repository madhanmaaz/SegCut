# =====================================
# SegCut Installer / Updater / Remover
# =====================================

param (
    [Parameter(Mandatory = $true)]
    [ValidateSet("install", "update", "uninstall")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

# -------------------
# Config
# -------------------
$appName        = "SegCut"
$repoZipUrl     = "https://github.com/madhanmaaz/SegCut/archive/refs/heads/main.zip"
$packageJsonUrl = "https://raw.githubusercontent.com/madhanmaaz/SegCut/refs/heads/main/package.json"

$installRoot    = "$env:LOCALAPPDATA\Programs\$appName"
$ffmpegRoot     = "$env:LOCALAPPDATA\Programs\ffmpeg"
$startMenuPath  = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$appName"
$scriptPath     = "$installRoot\scripts\install.ps1"

$tempZip        = "$env:TEMP\segcut.zip"
$tempExtract    = "$env:TEMP\segcut_extract"

# -------------------
# Utility
# -------------------
function Write-Step($message) {
    Write-Host "`n==> $message" -ForegroundColor Cyan
}

function Clean-Temp {
    if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
}

# -------------------
# Download App
# -------------------
function Download-And-Extract {
    Write-Step "Downloading latest version..."
    Clean-Temp

    Invoke-WebRequest -Uri $repoZipUrl -OutFile $tempZip
    Expand-Archive $tempZip -DestinationPath $tempExtract -Force

    $sourceFolder = Get-ChildItem $tempExtract | Where-Object { $_.PSIsContainer } | Select-Object -First 1

    # Ensure install directory exists and is a directory
    if (Test-Path $installRoot) {
        if (-not (Test-Path $installRoot -PathType Container)) {
            Remove-Item $installRoot -Force
            New-Item -ItemType Directory -Path $installRoot | Out-Null
        }
        else {
            # Clear existing contents safely
            Get-ChildItem $installRoot -Force | Remove-Item -Recurse -Force
        }
    }
    else {
        New-Item -ItemType Directory -Path $installRoot | Out-Null
    }

    Copy-Item -Path "$($sourceFolder.FullName)\*" -Destination $installRoot -Recurse -Force
    Clean-Temp
}

# -------------------
# Node.js
# -------------------
function Ensure-Node {
    if ((Get-Command node -ErrorAction SilentlyContinue) -and
        (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Step "Node.js already installed"
        return
    }

    Write-Step "Installing Node.js..."
    $nodeInstaller = "$env:TEMP\node.msi"

    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi" -OutFile $nodeInstaller
    Start-Process msiexec.exe -Wait -ArgumentList "/i `"$nodeInstaller`" /qn"
    Remove-Item $nodeInstaller -Force

    Write-Step "Node.js installed"
}

# -------------------
# FFmpeg
# -------------------
function Ensure-FFmpeg {
    if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
        Write-Step "FFmpeg already installed"
        return
    }

    Write-Step "Installing FFmpeg..."

    $ffmpegZip     = "$env:TEMP\ffmpeg.zip"
    $ffmpegExtract = "$env:TEMP\ffmpeg_extract"

    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip
    Expand-Archive $ffmpegZip -DestinationPath $ffmpegExtract -Force

    $ffmpegFolder = Get-ChildItem $ffmpegExtract | Where-Object { $_.PSIsContainer } | Select-Object -First 1

    if (Test-Path $ffmpegRoot) {
        Remove-Item $ffmpegRoot -Recurse -Force
    }

    Move-Item $ffmpegFolder.FullName $ffmpegRoot -Force

    # Add to PATH safely
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$ffmpegRoot\bin*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$ffmpegRoot\bin", "User")
    }

    Remove-Item $ffmpegZip -Force
    Remove-Item $ffmpegExtract -Recurse -Force

    Write-Step "FFmpeg installed"
}

# -------------------
# Start Menu Shortcuts
# -------------------
function Create-StartMenuShortcuts {
    Write-Step "Creating Start Menu shortcuts..."

    if (!(Test-Path $startMenuPath)) {
        New-Item -ItemType Directory -Path $startMenuPath | Out-Null
    }

    $WshShell = New-Object -ComObject WScript.Shell

    # Main App
    $appShortcut = $WshShell.CreateShortcut("$startMenuPath\$appName.lnk")
    $appShortcut.TargetPath = "node"
    $appShortcut.Arguments = "`"$installRoot\main.js`""
    $appShortcut.WorkingDirectory = $installRoot
    $appShortcut.IconLocation = "$installRoot\icon.ico"
    $appShortcut.Save()

    # Updater
    $updateShortcut = $WshShell.CreateShortcut("$startMenuPath\$appName Updater.lnk")
    $updateShortcut.TargetPath = "powershell"
    $updateShortcut.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`" -Action update"
    $updateShortcut.WorkingDirectory = $installRoot
    $updateShortcut.IconLocation = "$installRoot\icon.ico"
    $updateShortcut.Save()

    # Uninstaller
    $removeShortcut = $WshShell.CreateShortcut("$startMenuPath\$appName Uninstaller.lnk")
    $removeShortcut.TargetPath = "powershell"
    $removeShortcut.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`" -Action uninstall"
    $removeShortcut.IconLocation = "$installRoot\icon.ico"
    $removeShortcut.Save()

    Write-Step "Shortcuts created"
}

# -------------------
# Version Check
# -------------------
function Get-RemoteVersion {
    $json = Invoke-WebRequest -Uri $packageJsonUrl -UseBasicParsing
    return (ConvertFrom-Json $json.Content).version
}

function Get-LocalVersion {
    if (!(Test-Path "$installRoot\package.json")) { return $null }
    return (Get-Content "$installRoot\package.json" | ConvertFrom-Json).version
}

# -------------------
# Install
# -------------------
function Install-SegCut {
    Write-Step "Installing $appName"

    Ensure-Node
    Ensure-FFmpeg
    Download-And-Extract

    Set-Location $installRoot
    npm install --silent

    Create-StartMenuShortcuts

    Write-Step "$appName installed successfully!"
}

# -------------------
# Update
# -------------------
function Update-SegCut {
    Write-Step "Checking for updates..."

    $localVersion  = Get-LocalVersion
    $remoteVersion = Get-RemoteVersion

    if ($localVersion -and $localVersion -eq $remoteVersion) {
        Write-Step "Already up to date (v$localVersion)"
        [void][System.Console]::ReadLine()
        return
    }

    Write-Step "Updating from v$localVersion to v$remoteVersion"

    Download-And-Extract
    Set-Location $installRoot
    npm install --silent

    Write-Step "Update complete!"
    [void][System.Console]::ReadLine()
}

# -------------------
# Uninstall
# -------------------
function Uninstall-SegCut {
    Write-Step "Uninstalling $appName..."

    if (Test-Path $installRoot) {
        Remove-Item $installRoot -Recurse -Force
    }

    if (Test-Path $startMenuPath) {
        Remove-Item $startMenuPath -Recurse -Force
    }

    Write-Step "$appName removed successfully"
    [void][System.Console]::ReadLine()
}

# -------------------
# Entry Point
# -------------------
switch ($Action) {
    "update"    { Update-SegCut }
    "uninstall" { Uninstall-SegCut }
    default { Install-SegCut }
}
