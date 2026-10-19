$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;
public static class TrayInput {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Ended;
    public static volatile bool Failed;
    public static void Start() {
        var thread = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (line.Length > 4096 || Lines.Count >= 64) throw new InvalidOperationException();
                    Lines.Enqueue(line);
                }
            } catch { Failed = true; }
            finally { Ended = true; }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@

$context = [System.Windows.Forms.ApplicationContext]::new()
$icon = [System.Windows.Forms.NotifyIcon]::new()
$applicationIcon = [System.Drawing.Icon]::new($env:SWU_TRAY_ICON_PATH, 32, 32)
$icon.Icon = $applicationIcon
$icon.Text = '西大日常 · 后台运行中'
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$open = $menu.Items.Add('打开西大日常')
$open.Add_Click({ [Console]::WriteLine('{"type":"open"}') })
$quit = $menu.Items.Add('退出程序')
$quit.Add_Click({ [Console]::WriteLine('{"type":"quit"}') })
$icon.ContextMenuStrip = $menu
$icon.Add_DoubleClick({ [Console]::WriteLine('{"type":"open"}') })
$icon.Add_BalloonTipClicked({ [Console]::WriteLine('{"type":"open"}') })
$icon.Visible = $true
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
    try {
        if ([TrayInput]::Failed) { throw 'Notification input failed.' }
        $line = $null
        while ([TrayInput]::Lines.TryDequeue([ref]$line)) {
            $request = $line | ConvertFrom-Json
            if ($request.command -eq 'shutdown') { $context.ExitThread(); return }
            if ($request.command -ne 'notify' -or $request.id -notmatch '^[a-f0-9-]{36}$' -or
                [string]::IsNullOrWhiteSpace($request.title) -or $request.title.Length -gt 63 -or
                [string]::IsNullOrWhiteSpace($request.body) -or $request.body.Length -gt 500) {
                throw 'Invalid notification command.'
            }
            $icon.ShowBalloonTip(10000, $request.title, $request.body, [System.Windows.Forms.ToolTipIcon]::Info)
            [Console]::WriteLine((@{type='accepted'; id=$request.id} | ConvertTo-Json -Compress))
        }
        if ([TrayInput]::Ended) { $context.ExitThread() }
    } catch {
        [Console]::WriteLine('{"type":"error","message":"Windows tray notification failed."}')
        $context.ExitThread()
    }
})
try {
    [TrayInput]::Start()
    $timer.Start()
    [Console]::WriteLine('{"type":"ready"}')
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop()
    $timer.Dispose()
    $icon.Visible = $false
    $icon.Dispose()
    $applicationIcon.Dispose()
    $menu.Dispose()
    $context.Dispose()
}
