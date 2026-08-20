!include "WordFunc.nsh"

!macro customInstall
  DetailPrint "Adding Switchboard CLI to PATH"
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 != ""
    ${WordFind} "$0" "$INSTDIR\bin" "E+1{" $R0
    ${If} $R0 != ""
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR\bin"
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${Else}
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR\bin"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Switchboard CLI from PATH"
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${WordReplace} "$0" ";$INSTDIR\bin" "" "+" $R0
  ${WordReplace} "$R0" "$INSTDIR\bin;" "" "+" $R1
  ${WordReplace} "$R1" "$INSTDIR\bin" "" "+" $R2
  WriteRegExpandStr HKCU "Environment" "PATH" "$R2"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
