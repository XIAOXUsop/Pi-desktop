$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetFolder = Join-Path (Split-Path -Parent $PSScriptRoot) 'build'
New-Item -ItemType Directory -Path $assetFolder -Force | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(8,8,80,80,180,90)
$shape.AddArc(168,8,80,80,270,90)
$shape.AddArc(168,168,80,80,0,90)
$shape.AddArc(8,168,80,80,90,90)
$shape.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#A9D5F2'))
$graphics.FillPath($brush,$shape)
$pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#23465F')),14
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLines($pen,[System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 86,91),(New-Object System.Drawing.PointF 50,128),(New-Object System.Drawing.PointF 86,165)))
$graphics.DrawLine($pen,146,76,110,180)
$graphics.DrawLines($pen,[System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 170,91),(New-Object System.Drawing.PointF 206,128),(New-Object System.Drawing.PointF 170,165)))
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
$png = $memory.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $assetFolder 'app.png'),$png)
$iconStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $iconStream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
[System.IO.File]::WriteAllBytes((Join-Path $assetFolder 'app.ico'),$iconStream.ToArray())
$writer.Dispose();$iconStream.Dispose();$memory.Dispose();$pen.Dispose();$brush.Dispose();$shape.Dispose();$graphics.Dispose();$bitmap.Dispose()
