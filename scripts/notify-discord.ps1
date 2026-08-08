param(
    [string]$Status = "Completed",
    [string]$Message = "Codex task completed"
)

$WebhookUrl = $env:DISCORD_WEBHOOK_URL

if ([string]::IsNullOrWhiteSpace($WebhookUrl)) {
    Write-Error "DISCORD_WEBHOOK_URL is not set."
    exit 1
}

$RepoName = Split-Path -Leaf (Get-Location)

$Branch = git branch --show-current 2>$null
if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = "Unknown"
}

$Commit = git log -1 --pretty=format:"%h %s" 2>$null
if ([string]::IsNullOrWhiteSpace($Commit)) {
    $Commit = "No commit found"
}

$Text = @"
**Codex Notification**

**Status**
$Status

**Message**
$Message

**Repository**
$RepoName

**Branch**
$Branch

**Latest commit**
$Commit
"@

$Payload = @{
    username = "Codex"
    content = $Text
} | ConvertTo-Json -Depth 5

try {
    Invoke-RestMethod `
        -Uri $WebhookUrl `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($Payload))

    Write-Host "Discord notification sent."
}
catch {
    Write-Error "Discord notification failed."
    Write-Error $_.Exception.Message
    exit 1
}

# Discord notification usage
#
# When a task is completed, run this command before the final response:
# powershell -ExecutionPolicy Bypass -File .\scripts\notify-discord.ps1 -Status "Completed" -Message "Summarize the changes and test results"
#
# Replace the Message value with a short summary of the actual work completed.
# If the task could not be completed, use:
# powershell -ExecutionPolicy Bypass -File .\scripts\notify-discord.ps1 -Status "Needs attention" -Message "Summarize the unresolved problem"
#
# Do not display or edit DISCORD_WEBHOOK_URL.
