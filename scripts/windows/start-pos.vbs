' ---------------------------------------------------------------------------
'  AbidChatkhara POS — one-click launcher (Option C)
'
'  Double-click this (or a desktop shortcut to it) to open the till.
'   - If the POS server is not already running, it starts it HIDDEN
'     (no console window) and waits until it is ready.
'   - Then it opens the app in its own window (Chrome app mode if Chrome
'     is installed, otherwise the default browser).
'  Run it again any time: it notices the server is already up and just
'  opens the app.
'
'  The server keeps running in the background after you close the window,
'  so nothing is lost. To stop it, run stop-pos.bat (or shut the PC down).
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, projDir, url, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The project root is two folders up from this script (scripts\windows\).
projDir = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
url = "http://localhost:4000"

' --- Is a server already listening on port 4000? ---
If Not ServerIsUp(url) Then
  shell.CurrentDirectory = projDir
  ' 0 = hidden window, False = do not wait. Logs go to pos-server.log.
  shell.Run "cmd /c npm.cmd start > pos-server.log 2>&1", 0, False

  ' Wait up to ~40s for it to come up.
  For i = 1 To 80
    WScript.Sleep 500
    If ServerIsUp(url) Then Exit For
  Next
End If

' --- Open the till ---
Dim chrome
chrome = FindChrome()
If chrome <> "" Then
  ' --app gives the clean, chrome-less window titled "Restaurant POS".
  shell.Run """" & chrome & """ --app=" & url, 1, False
Else
  shell.Run url, 1, False
End If

WScript.Quit 0

' ---------------------------------------------------------------------------

' True as soon as ANYTHING answers on the URL — a 200, 401 or 404 all mean
' the server process is up. We only care that the port is listening.
Function ServerIsUp(u)
  Dim http
  ServerIsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.open "GET", u, False
  http.send
  If Err.Number = 0 Then ServerIsUp = True
  On Error GoTo 0
End Function

Function FindChrome()
  Dim fso2, candidates, p
  Set fso2 = CreateObject("Scripting.FileSystemObject")
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
    shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe") )
  FindChrome = ""
  For Each p In candidates
    If fso2.FileExists(p) Then
      FindChrome = p
      Exit For
    End If
  Next
End Function
