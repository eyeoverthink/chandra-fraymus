# Fixed trusted file-bytes worker. No paths, URLs, UI, clipboard or network APIs.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false,$true)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false,$true)
$stream=$null;$writer=$null;$bitmap=$null;$stage='input'
function Output-Json($value) {
    $encoded=$value | ConvertTo-Json -Depth 6 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 250000) { throw 'ocr_output_limit' }
    [Console]::Out.Write($encoded)
}
try {
    $raw=[Console]::In.ReadToEnd()
    if ($raw.Length -gt 6291456) {throw 'ocr_input_limit'}
    $request=$raw | ConvertFrom-Json
    $allowed=if($request.action -eq 'health'){@('action')}elseif($request.action -eq 'recognize'){@('action','imageBase64','mimeType','language')}else{throw 'ocr_invalid_request'}
    $keys=@($request.PSObject.Properties.Name)
    if($keys.Count -ne $allowed.Count -or @($keys | Where-Object {$_ -notin $allowed}).Count){throw 'ocr_invalid_request'}
    $stage='initialize'
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
    $languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})
    if($languages.Count -gt 128){throw 'ocr_language_limit'}
    $maximum=[int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $base=[ordered]@{ok=$false;engine='windows-media-ocr';languages=$languages;maxImageDimension=$maximum;osBuild=[Environment]::OSVersion.Version.Build;accuracyVerified=$false;requiresReview=$true;confidenceAvailable=$false}
    $engine=$null
    if('en-US' -in $languages){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))}
    $base.available=($null -ne $engine)
    if($null -eq $engine){$base.code='ocr_unavailable';Output-Json $base;exit 3}
    if($request.action -eq 'health'){$base.ok=$true;Output-Json $base;exit 0}
    if($request.language -cne 'en-US' -or $request.mimeType -notin @('image/png','image/jpeg')){throw 'ocr_invalid_request'}
    $stage='bytes'
    $encoded=$request.imageBase64
    if($encoded -isnot [string] -or -not $encoded.Length -or $encoded.Length -gt 5592408 -or $encoded.Length%4 -or $encoded -cnotmatch '^[A-Za-z0-9+/]*={0,2}$'){throw 'ocr_invalid_base64'}
    $bytes=[Convert]::FromBase64String($encoded)
    if($bytes.Length -gt 4194304 -or [Convert]::ToBase64String($bytes) -cne $encoded){throw 'ocr_invalid_base64'}
    if($request.mimeType -eq 'image/png') {
        if($bytes.Length -lt 8 -or [BitConverter]::ToString($bytes,0,8) -cne '89-50-4E-47-0D-0A-1A-0A'){throw 'ocr_invalid_image'}
    } elseif($bytes.Length -lt 3 -or $bytes[0] -ne 255 -or $bytes[1] -ne 216 -or $bytes[2] -ne 255){throw 'ocr_invalid_image'}
    $hasher=[Security.Cryptography.SHA256]::Create()
    try{$imageHash=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
    $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
    if($null -eq $asTask){throw 'ocr_async_unavailable'}
    function Await-Native($operation,[Type]$type) {
        $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation))
        if(-not $task.Wait(5000)){try{$operation.Cancel()}catch{};throw 'ocr_timeout'}
        return $task.GetAwaiter().GetResult()
    }
    $stage='decode_metadata'
    $stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer=[Windows.Storage.Streams.DataWriter]::new($stream.GetOutputStreamAt(0))
    $writer.WriteBytes($bytes)
    $null=Await-Native ($writer.StoreAsync()) ([uint32])
    $null=$writer.DetachStream();$writer.Dispose();$writer=$null;$stream.Seek(0)
    $decoder=Await-Native ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $width,$height=[int]$decoder.PixelWidth,[int]$decoder.PixelHeight
    if($width -lt 1 -or $height -lt 1 -or $width -gt 4096 -or $height -gt 4096 -or $width -gt $maximum -or $height -gt $maximum -or [long]$width*$height -gt 4000000){throw 'ocr_image_limit'}
    $stage='decode_pixels'
    $transform=[Windows.Graphics.Imaging.BitmapTransform]::new()
    $bitmap=Await-Native ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,$transform,[Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if($bitmap.PixelWidth -ne $width -or $bitmap.PixelHeight -ne $height){throw 'ocr_dimension_mismatch'}
    $stage='recognize'
    $result=Await-Native ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lineList=New-Object 'System.Collections.Generic.List[object]';$wordCount=0
    foreach($line in $result.Lines){
        foreach($word in $line.Words){$wordCount++;if($wordCount -gt 4000){throw 'ocr_output_limit'}}
        $lineList.Add([ordered]@{text=[string]$line.Text})
        if($lineList.Count -gt 1000){throw 'ocr_output_limit'}
    }
    $lines=$lineList.ToArray()
    $text=(@($lines | ForEach-Object {$_.text}) -join "`n")
    $textBytes=[Console]::OutputEncoding.GetByteCount($text)
    if($textBytes -gt 65536 -or $text.Contains([string][char]0)){throw 'ocr_output_limit'}
    $base.ok=$true;$base.language=$engine.RecognizerLanguage.LanguageTag;$base.text=$text;$base.lines=$lines
    $base.wordCount=$wordCount;$base.textBytes=$textBytes;$base.width=$width;$base.height=$height;$base.imageSha256=$imageHash
    $base.orientation='raw-pixels-exif-ignored'
    Output-Json $base
    exit 0
}catch{
    $exception=$_.Exception;while($null -ne $exception.InnerException){$exception=$exception.InnerException}
    $code=if($exception.Message -cmatch '^ocr_[a-z_]+$'){$exception.Message}else{'ocr_native_failed'}
    $detail=[string]$exception.Message;if($detail.Length -gt 300){$detail=$detail.Substring(0,300)}
    Output-Json @{ok=$false;engine='windows-media-ocr';code=$code;stage=$stage;exceptionType=$exception.GetType().FullName;detail=$detail;hresult=('0x{0:x8}' -f ([uint32]([long]$exception.HResult -band 4294967295)))}
    exit 2
}finally{
    if($bitmap){$bitmap.Dispose()};if($writer){$writer.Dispose()};if($stream){$stream.Dispose()}
}
