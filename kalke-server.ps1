# Kalke local web server
# Serves this folder on http://localhost:8765/ and opens it in your browser.
# Keep the window open while you use the app. Close it (or press Ctrl+C) to stop.

$ErrorActionPreference = 'Stop'
$Port = 8765
$url = "http://localhost:$Port/"
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$rootPrefix = $root.TrimEnd('\') + '\'

$types = @{
  '.html'    = 'text/html; charset=utf-8'
  '.css'     = 'text/css; charset=utf-8'
  '.js'      = 'application/javascript; charset=utf-8'
  '.json'    = 'application/json; charset=utf-8'
  '.geojson' = 'application/geo+json; charset=utf-8'
  '.kml'     = 'application/vnd.google-earth.kml+xml'
  '.md'      = 'text/plain; charset=utf-8'
  '.webmanifest' = 'application/manifest+json'
  '.png'     = 'image/png'
  '.jpg'     = 'image/jpeg'
  '.svg'     = 'image/svg+xml'
  '.ico'     = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  # The port is taken. Most likely Kalke is already running in another window.
  try {
    $null = Invoke-WebRequest -Uri ($url + 'app.js') -UseBasicParsing -TimeoutSec 2
    Write-Host "Kalke is already running. Opening $url"
    Start-Process $url
    exit 0
  } catch {
    Write-Host "Port $Port is used by another program, so the local server could not start."
    exit 1
  }
}

Write-Host ''
Write-Host "  Kalke is running at $url"
Write-Host '  Keep this window open while you plan. Close it to stop the app.'
Write-Host ''
Start-Process $url

try {
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    # Wait in short slices so Ctrl+C is handled promptly.
    while (-not $async.AsyncWaitHandle.WaitOne(500)) { }
    $ctx = $listener.EndGetContext($async)
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
      $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))

      if ($full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($full)) {
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] } else { $res.ContentType = 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($full)
      } else {
        $res.StatusCode = 404
        $res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
      }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch { }
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
