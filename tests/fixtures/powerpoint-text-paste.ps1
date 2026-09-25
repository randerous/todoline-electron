$ErrorActionPreference = 'Stop'
$application = New-Object -ComObject PowerPoint.Application
$ownedApplication = $application.Presentations.Count -eq 0
$presentation = $null
try {
  $presentation = $application.Presentations.Add(0)
  $slide = $presentation.Slides.Add(1, 12)
  $shape = $slide.Shapes.AddTextbox(1, 20, 20, 500, 200)
  $shape.TextFrame.TextRange.Text = 'AB'
  $null = $shape.TextFrame.TextRange.Characters(2, 0).Paste()
  @{text=$shape.TextFrame.TextRange.Text;shapes=$slide.Shapes.Count} | ConvertTo-Json -Compress
} finally {
  if ($null -ne $presentation) { $presentation.Saved = -1; $presentation.Close() }
  if ($ownedApplication) { $application.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
}
