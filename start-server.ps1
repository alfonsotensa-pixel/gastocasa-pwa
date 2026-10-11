# Servidor Local Autónomo para GastoCasa PWA (Sin Node ni Python requeridos)
$port = 8080
$prefix = "http://localhost:$port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
    Write-Host "=======================================================" -ForegroundColor Cyan
    Write-Host " [GASTOCASA // BRUTAL] Servidor PWA Activo" -ForegroundColor Green
    Write-Host " Abriendo en: $prefix" -ForegroundColor Yellow
    Write-Host " Presiona Ctrl+C en esta terminal para detener el servidor" -ForegroundColor DarkGray
    Write-Host "=======================================================" -ForegroundColor Cyan

    # Abrir automáticamente el navegador predeterminado
    Start-Process $prefix

    $baseDir = $PSScriptRoot

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $rawPath = $request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($rawPath)) {
            $rawPath = "index.html"
        }

        $localPath = Join-Path $baseDir $rawPath

        if (Test-Path $localPath -PathType Leaf) {
            $contentBytes = [System.IO.File]::ReadAllBytes($localPath)
            
            # Asignar Content-Type adecuado
            $ext = [System.IO.Path]::GetExtension($localPath).ToLower()
            switch ($ext) {
                ".html" { $response.ContentType = "text/html; charset=utf-8" }
                ".css"  { $response.ContentType = "text/css; charset=utf-8" }
                ".js"   { $response.ContentType = "application/javascript; charset=utf-8" }
                ".json" { $response.ContentType = "application/json; charset=utf-8" }
                ".webmanifest" { $response.ContentType = "application/manifest+json; charset=utf-8" }
                ".svg"  { $response.ContentType = "image/svg+xml" }
                ".png"  { $response.ContentType = "image/png" }
                default { $response.ContentType = "application/octet-stream" }
            }

            $response.ContentLength64 = $contentBytes.Length
            $response.OutputStream.Write($contentBytes, 0, $contentBytes.Length)
        } else {
            $response.StatusCode = 404
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 No Encontrado")
            $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }

        $response.Close()
    }
} catch {
    Write-Host "Error en el servidor: $_" -ForegroundColor Red
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
}
