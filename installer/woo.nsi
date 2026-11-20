Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"

!define APP_NAME "WOO 我的世界启动器"
!define APP_VERSION "1.2.4"
!define APP_EXE "WOO 我的世界启动器.exe"
!define APP_PUBLISHER "small-kCoding"
!define APP_URL "https://home.small-k.cc.cd"
!define PART1_URL "https://gitee.com/small-kCoding/woo_mc_launcher/releases/download/v1.2.4/WOO-MC-Launcher-1.2.4-win-x64-part1.zip"
!define PART2_URL "https://gitee.com/small-kCoding/woo_mc_launcher/releases/download/v1.2.4/WOO-MC-Launcher-1.2.4-win-x64-part2.zip"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WOO-MC-Launcher"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\release\WOO-MC-Launcher-${APP_VERSION}-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\WOO 我的世界启动器"
InstallDirRegKey HKCU "Software\WOO-MC-Launcher" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "..\build\icon.ico"
UninstallIcon "..\build\icon.ico"
BrandingText "${APP_NAME}"

VIProductVersion "1.2.4.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "LegalCopyright" "small-kCoding"

!define MUI_ABORTWARNING
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "安装程序会从网络下载约 173 MB 的程序文件，并安装到你的电脑。$\r$\n$\r$\n默认安装到当前用户目录，不需要管理员权限。点击“下一步”继续。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。建议保持默认目录。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "运行 ${APP_NAME}"
!define MUI_FINISHPAGE_LINK "访问官网"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "-主程序" SecMain
  SectionIn RO
  ; 程序文件在安装时从网络下载，这里手动声明所需空间，避免目录页显示 0.0 KB
  AddSize 480000
  SetOutPath "$INSTDIR"
  SetDetailsPrint both

  DetailPrint "正在下载主程序（分卷 1/2，约 97 MB）..."
  inetc::get /CONNECTTIMEOUT 20 /RECEIVETIMEOUT 300 "${PART1_URL}" "$TEMP\woo-part1.zip" /END
  Pop $0
  ${If} $0 != "OK"
    MessageBox MB_ICONSTOP "下载分卷 1 失败：$0$\r$\n请检查网络后重试。"
    Abort
  ${EndIf}
  nsExec::ExecToStack 'cmd /c for %I in ("$TEMP\woo-part1.zip") do @echo %~zI'
  Pop $0
  Pop $1
  ${TrimNewLines} "$1" $1
  ${If} $1 != "101660902"
    DetailPrint "分卷 1 大小异常，正在重新下载..."
    nsExec::ExecToLog 'curl.exe -L --fail --retry 3 --connect-timeout 20 -o "$TEMP\woo-part1.zip" "${PART1_URL}"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "下载分卷 1 失败，请检查网络后重试。"
      Abort
    ${EndIf}
  ${EndIf}

  DetailPrint "正在下载运行库（分卷 2/2，约 77 MB）..."
  inetc::get /CONNECTTIMEOUT 20 /RECEIVETIMEOUT 300 "${PART2_URL}" "$TEMP\woo-part2.zip" /END
  Pop $0
  ${If} $0 != "OK"
    MessageBox MB_ICONSTOP "下载分卷 2 失败：$0$\r$\n请检查网络后重试。"
    Abort
  ${EndIf}
  nsExec::ExecToStack 'cmd /c for %I in ("$TEMP\woo-part2.zip") do @echo %~zI'
  Pop $0
  Pop $1
  ${TrimNewLines} "$1" $1
  ${If} $1 != "80283719"
    DetailPrint "分卷 2 大小异常，正在重新下载..."
    nsExec::ExecToLog 'curl.exe -L --fail --retry 3 --connect-timeout 20 -o "$TEMP\woo-part2.zip" "${PART2_URL}"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "下载分卷 2 失败，请检查网络后重试。"
      Abort
    ${EndIf}
  ${EndIf}

  DetailPrint "正在解压，请稍候..."
  nsExec::ExecToLog 'tar.exe -xf "$TEMP\woo-part1.zip" -C "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "解压分卷 1 失败（代码 $0）。请确认磁盘空间充足后重试。"
    Abort
  ${EndIf}
  nsExec::ExecToLog 'tar.exe -xf "$TEMP\woo-part2.zip" -C "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "解压分卷 2 失败（代码 $0）。请确认磁盘空间充足后重试。"
    Abort
  ${EndIf}

  Delete "$TEMP\woo-part1.zip"
  Delete "$TEMP\woo-part2.zip"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\WOO-MC-Launcher" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\WOO 我的世界启动器"
  CreateShortCut "$SMPROGRAMS\WOO 我的世界启动器\WOO 我的世界启动器.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\WOO 我的世界启动器\卸载 WOO.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\WOO 我的世界启动器.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "下载并安装 WOO 我的世界启动器主程序和运行库。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面创建快捷方式。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$DESKTOP\WOO 我的世界启动器.lnk"
  Delete "$SMPROGRAMS\WOO 我的世界启动器\WOO 我的世界启动器.lnk"
  Delete "$SMPROGRAMS\WOO 我的世界启动器\卸载 WOO.lnk"
  RMDir "$SMPROGRAMS\WOO 我的世界启动器"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\WOO-MC-Launcher"
SectionEnd
