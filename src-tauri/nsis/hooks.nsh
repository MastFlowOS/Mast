!macro StopMastDesktopWorker
  ; Terminate any running or orphaned worker tree so PyInstaller _internal DLLs
  ; (such as VCRUNTIME140.dll) are unlocked before copying or removing files.
  nsExec::Exec 'taskkill /F /T /IM mast-desktop-worker.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopMastDesktopWorker
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopMastDesktopWorker
!macroend
