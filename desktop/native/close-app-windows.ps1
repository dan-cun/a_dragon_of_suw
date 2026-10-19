$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SwuCommandLine {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        int count; var memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot parse browser command line.");
        try { var result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size)); return result; }
        finally { LocalFree(memory); }
    }
}
'@
$profiles = @($request.profiles | ForEach-Object { [IO.Path]::GetFullPath($_) })
foreach ($browser in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")) {
    if (-not $browser.CommandLine) { continue }
    $arguments = [SwuCommandLine]::Parse($browser.CommandLine)
    if (@($arguments | Where-Object { $_.StartsWith('--type=') }).Count -gt 0) { continue }
    $profileArgument = @($arguments | Where-Object { $_.StartsWith('--user-data-dir=') })
    if ($profileArgument.Count -ne 1) { continue }
    $profile = [IO.Path]::GetFullPath($profileArgument[0].Substring('--user-data-dir='.Length))
    if ($profiles -contains $profile) {
        # Only close the application's dedicated UI browser, never normal Edge or the school browser.
        Stop-Process -Id $browser.ProcessId -Force
    }
}
[Console]::Write('ok')
