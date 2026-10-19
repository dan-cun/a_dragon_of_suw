param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[byte[]]]::new()
$image = [System.Drawing.Image]::FromFile($Source)
try {
    if ($image.Width -ne $image.Height) { throw 'The logo master must be square.' }
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $frame = [System.IO.MemoryStream]::new()
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.DrawImage($image, 0, 0, $size, $size)
            $bitmap.Save($frame, [System.Drawing.Imaging.ImageFormat]::Png)
            $bytes = $frame.ToArray()
            $frames.Add($bytes)
            if ($size -eq 256) { [System.IO.File]::WriteAllBytes((Join-Path $Output 'icon.png'), $bytes) }
        } finally {
            $frame.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($index = 0; $index -lt $sizes.Count; $index++) {
            $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$frames[$index].Length)
            $writer.Write([uint32]$offset)
            $offset += $frames[$index].Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
        $writer.Flush()
        [System.IO.File]::WriteAllBytes((Join-Path $Output 'icon.ico'), $stream.ToArray())
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
} finally { $image.Dispose() }
