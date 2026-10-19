$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = 'Software\Microsoft\Windows\CurrentVersion\Run'
if ($request.enabled -eq $true) {
    if (-not [IO.File]::Exists($request.executable)) { throw 'Executable does not exist.' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path, $true)
    try { $key.SetValue('SWU-Daka-Desktop', '"' + $request.executable + '" --no-window', [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
} else {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)
    if ($null -ne $key) {
        try {
            $value = $key.GetValue('SWU-Daka-Desktop')
            if ($value -eq ('"' + $request.executable + '" --no-window') -or $value -eq ('"' + $request.executable + '"')) {
                $key.DeleteValue('SWU-Daka-Desktop', $false)
            }
        }
        finally { $key.Dispose() }
    }
}
[Console]::Write('ok')
