param(
    [Parameter(Mandatory=$true)]
    [int]$Id,

    [Parameter(Mandatory=$true)]
    [int]$Parent,

    [string]$ApiBase = "http://127.0.0.1:3800"
)

# Links work item #Id under parent #Parent. Any existing parent is replaced
# (a work item can have only one parent).
$body = @{ parent = $Parent } | ConvertTo-Json -Compress
$result = Invoke-RestMethod "$ApiBase/api/workitems/$Id/parent" -Method POST -ContentType 'application/json' -Body $body

if ($result.ok) {
    Write-Host "`n  Linked #$Id under parent #$Parent." -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "`n  Error: $($result.error)`n" -ForegroundColor Red
}
