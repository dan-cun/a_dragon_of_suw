$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
$null = [Windows.Devices.Geolocation.Geoposition, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
$null = [Windows.Devices.Geolocation.GeolocationAccessStatus, Windows.Devices.Geolocation, ContentType = WindowsRuntime]

function Wait-WinRtResult {
    param([object]$Operation, [type]$ResultType)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if ($null -eq $method) { throw 'Windows Runtime async bridge is unavailable.' }
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(22000)) { throw 'Windows location request timed out.' }
    return $task.Result
}

try {
    $access = Wait-WinRtResult -Operation ([Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()) -ResultType ([Windows.Devices.Geolocation.GeolocationAccessStatus])
    if ($access.ToString() -ne 'Allowed') { throw 'Windows location permission is denied. Enable Location services and Let desktop apps access your location in Windows Settings.' }
    $locator = New-Object Windows.Devices.Geolocation.Geolocator
    $locator.DesiredAccuracyInMeters = 100
    $position = Wait-WinRtResult -Operation ($locator.GetGeopositionAsync([TimeSpan]::Zero, [TimeSpan]::FromSeconds(20))) -ResultType ([Windows.Devices.Geolocation.Geoposition])
    $coordinate = $position.Coordinate
    $source = $coordinate.PositionSource.ToString()
    if ($source -eq 'Default' -or $source -eq 'Unknown' -or $source -eq 'Obfuscated') { throw 'Windows returned a default or unknown position instead of a current device position.' }
    @{
        ok = $true
        value = @{
            latitude = $coordinate.Point.Position.Latitude
            longitude = $coordinate.Point.Position.Longitude
            accuracy = $coordinate.Accuracy
            timestamp = $coordinate.Timestamp.ToUnixTimeMilliseconds()
            address = ''
        }
    } | ConvertTo-Json -Depth 3 -Compress
} catch {
    @{ ok = $false; error = @{ code = 'WINDOWS_LOCATION_FAILED'; message = $_.Exception.GetBaseException().Message } } | ConvertTo-Json -Depth 3 -Compress
    exit 1
}
