$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$connection = $null
$failure = $false
$disposed = $false

function Write-Event([object] $Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Read-Command([string] $Line, [string[]] $Fields) {
    if ($null -eq $Line -or $Line.Length -gt 16384) { throw 'INVALID_REQUEST' }
    $value = $Line | ConvertFrom-Json
    if ($null -eq $value -or $value -isnot [System.Management.Automation.PSCustomObject]) { throw 'INVALID_REQUEST' }
    $names = @($value.PSObject.Properties.Name)
    if ($names.Count -ne $Fields.Count) { throw 'INVALID_REQUEST' }
    foreach ($name in $names) { if ($Fields -cnotcontains $name) { throw 'INVALID_REQUEST' } }
    return $value
}

try {
    Add-Type -AssemblyName System.Speech
    # Only this external-system connector handles .NET background events; PowerShell polls its queue on the main thread.
    $connectorSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Speech.Synthesis;

public sealed class SwuSpeechNotice {
    public string Kind;
    public bool Cancelled;
    public bool HasError;
    public SwuSpeechNotice(string kind, bool cancelled, bool hasError) {
        Kind = kind; Cancelled = cancelled; HasError = hasError;
    }
}
public sealed class SwuSpeechVoice {
    public string Id;
    public string Name;
    public string Language;
    public SwuSpeechVoice(string id, string name, string language) {
        Id = id; Name = name; Language = language;
    }
}
public sealed class SwuSpeechConnector : IDisposable {
    private readonly SpeechSynthesizer synthesizer;
    private readonly ConcurrentQueue<SwuSpeechNotice> notices;
    public SwuSpeechConnector() {
        notices = new ConcurrentQueue<SwuSpeechNotice>();
        synthesizer = new SpeechSynthesizer();
        synthesizer.SpeakStarted += OnStarted;
        synthesizer.SpeakCompleted += OnCompleted;
    }
    private void OnStarted(object sender, SpeakStartedEventArgs args) {
        notices.Enqueue(new SwuSpeechNotice("speaking", false, false));
    }
    private void OnCompleted(object sender, SpeakCompletedEventArgs args) {
        bool expectedCancellation = args.Cancelled && args.Error is OperationCanceledException;
        notices.Enqueue(new SwuSpeechNotice("completed", args.Cancelled, args.Error != null && !expectedCancellation));
    }
    public SwuSpeechVoice[] Voices() {
        var result = new List<SwuSpeechVoice>();
        foreach (var installed in synthesizer.GetInstalledVoices()) {
            var voice = installed.VoiceInfo;
            if (installed.Enabled && voice.Culture.TwoLetterISOLanguageName == "en") {
                if (voice.Id.Length > 300 || voice.Name.Length > 300 || voice.Culture.Name.Length > 40 || result.Count >= 100) throw new InvalidOperationException("VOICE_UNAVAILABLE");
                result.Add(new SwuSpeechVoice(voice.Id, voice.Name, voice.Culture.Name));
            }
        }
        return result.ToArray();
    }
    public void Speak(string voiceId, string text, int rate) {
        SwuSpeechVoice selected = null;
        foreach (var voice in Voices()) {
            if (String.Equals(voice.Id, voiceId, StringComparison.Ordinal)) {
                if (selected != null) throw new InvalidOperationException("VOICE_UNAVAILABLE");
                selected = voice;
            }
        }
        if (selected == null) throw new InvalidOperationException("VOICE_UNAVAILABLE");
        synthesizer.SelectVoice(selected.Name);
        if (!String.Equals(synthesizer.Voice.Id, voiceId, StringComparison.Ordinal)) throw new InvalidOperationException("VOICE_MISMATCH");
        synthesizer.Rate = rate;
        synthesizer.SetOutputToDefaultAudioDevice();
        synthesizer.SpeakAsync(text);
    }
    public SwuSpeechNotice Poll() {
        SwuSpeechNotice notice;
        return notices.TryDequeue(out notice) ? notice : null;
    }
    public static System.Threading.Tasks.Task<string> ReadCommand() {
        return System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
    }
    public void Cancel() { synthesizer.SpeakAsyncCancelAll(); }
    public void Dispose() {
        var errors = new List<Exception>();
        try {
            try { synthesizer.SpeakStarted -= OnStarted; }
            catch (Exception error) { errors.Add(error); }
            try { synthesizer.SpeakCompleted -= OnCompleted; }
            catch (Exception error) { errors.Add(error); }
        } finally {
            try { synthesizer.Dispose(); }
            catch (Exception error) { errors.Add(error); }
        }
        if (errors.Count > 0) throw new AggregateException("NATIVE_DISPOSE_FAILED", errors);
    }
}
'@
    Add-Type -TypeDefinition $connectorSource -ReferencedAssemblies @('System.Speech', 'System', 'System.Core')
    $connection = New-Object SwuSpeechConnector
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { throw 'INVALID_REQUEST' }
    $request = $line | ConvertFrom-Json
    if ($null -eq $request -or $request.command -isnot [string]) { throw 'INVALID_REQUEST' }
    if ($request.command -ceq 'prepare') {
        $request = Read-Command $line @('command')
        $voices = @($connection.Voices() | ForEach-Object { @{ id = $_.Id; name = $_.Name; language = $_.Language } })
        Write-Event @{ event = 'catalogue'; voices = $voices }
    } elseif ($request.command -ceq 'speak') {
        $request = Read-Command $line @('command', 'voiceId', 'text', 'rate')
        if ($request.voiceId -isnot [string] -or $request.voiceId.Length -lt 1 -or $request.voiceId.Length -gt 300 -or $request.text -isnot [string] -or $request.text.Trim().Length -lt 1 -or $request.text.Length -gt 2000 -or ($request.rate -isnot [int] -and $request.rate -isnot [long]) -or $request.rate -lt -5 -or $request.rate -gt 5) { throw 'INVALID_REQUEST' }
        $connection.Speak($request.voiceId, $request.text, [int]$request.rate)
        Write-Event @{ event = 'accepted' }
        $completed = $false
        $cancelRequested = $false
        $cancelAt = $null
        $nextLine = [SwuSpeechConnector]::ReadCommand()
        while (-not $completed) {
            if ($nextLine.IsCompleted -and -not $cancelRequested) {
                $controlLine = $nextLine.GetAwaiter().GetResult()
                if ($null -ne $controlLine) {
                    $control = Read-Command $controlLine @('command')
                    if ($control.command -isnot [string] -or $control.command -cne 'cancel') { throw 'INVALID_REQUEST' }
                }
                $cancelRequested = $true
                $cancelAt = [DateTime]::UtcNow
                $connection.Cancel()
            }
            $notice = $connection.Poll()
            while ($null -ne $notice) {
                if ($notice.Kind -ceq 'speaking') { Write-Event @{ event = 'speaking' } }
                if ($notice.Kind -ceq 'completed') {
                    $errorCode = $null
                    if ($notice.HasError) { $errorCode = 'NATIVE_SPEECH_ERROR'; $failure = $true }
                    Write-Event @{ event = 'completed'; cancelled = $notice.Cancelled; errorCode = $errorCode }
                    $completed = $true
                }
                $notice = $connection.Poll()
            }
            if ($cancelRequested -and -not $completed -and ([DateTime]::UtcNow - $cancelAt).TotalSeconds -gt 10) { throw 'NATIVE_DISPOSE_FAILED' }
            if (-not $completed) { Start-Sleep -Milliseconds 20 }
        }
    } else { throw 'INVALID_REQUEST' }
} catch {
    $failure = $true
    $allowed = @('INVALID_REQUEST', 'VOICE_UNAVAILABLE', 'VOICE_MISMATCH', 'NATIVE_DISPOSE_FAILED')
    $code = 'NATIVE_INITIALIZATION_FAILED'
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($allowed -ccontains $exception.Message) { $code = $exception.Message; break }
        $exception = $exception.InnerException
    }
    Write-Event @{ event = 'failed'; code = $code }
} finally {
    if ($null -ne $connection) {
        try { $connection.Cancel() }
        catch { $failure = $true; Write-Event @{ event = 'failed'; code = 'NATIVE_CANCEL_FAILED' } }
        try { $connection.Dispose(); $disposed = $true }
        catch { $failure = $true; Write-Event @{ event = 'failed'; code = 'NATIVE_DISPOSE_FAILED' } }
    }
    if ($disposed) { Write-Event @{ event = 'closed' } }
}
if ($failure) { exit 1 }
exit 0
