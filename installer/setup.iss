#ifndef AppVersion
  #error AppVersion must be supplied by the build script
#endif
#ifndef SourceDir
  #error SourceDir must be supplied by the build script
#endif
#ifndef OutputPath
  #error OutputPath must be supplied by the build script
#endif

#ifndef WindowsVersion
  #error WindowsVersion must be supplied by the build script
#endif

#ifndef EditionLabel
  #error EditionLabel must be supplied by the build script
#endif

[Setup]
AppId={{D6FCA130-103B-4C33-B080-262012DA4B10}
AppName=西大日常（{#EditionLabel}）
AppVersion={#AppVersion}
AppPublisher=swu-daka contributors / dan-cun
AppPublisherURL=https://github.com/dan-cun/swu-daka
DefaultDirName={localappdata}\Programs\SWU-Daka
DefaultGroupName=西大日常
UsePreviousGroup=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\打卡助手.exe
LicenseFile=..\LICENSE
OutputDir={#OutputPath}
OutputBaseFilename=西大日常-{#AppVersion}-{#EditionLabel}-安装程序
VersionInfoVersion={#WindowsVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
Uninstallable=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "{#SourceDir}\打卡助手.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NOTICE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\DISCLAIMER.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
Type: files; Name: "{autodesktop}\打卡助手.lnk"
Type: files; Name: "{userprograms}\打卡助手\打卡助手.lnk"
Type: files; Name: "{userprograms}\打卡助手\使用说明.lnk"
Type: files; Name: "{userprograms}\打卡助手\卸载打卡助手.lnk"
Type: dirifempty; Name: "{userprograms}\打卡助手"

[Icons]
Name: "{autodesktop}\西大日常"; Filename: "{app}\打卡助手.exe"; WorkingDir: "{app}"
Name: "{group}\西大日常"; Filename: "{app}\打卡助手.exe"; WorkingDir: "{app}"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{group}\卸载西大日常"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\打卡助手.exe"; Description: "打开西大日常"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  ExtractTemporaryFile('打卡助手.exe');
  if not Exec(ExpandConstant('{tmp}\打卡助手.exe'), '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := '无法运行升级检查，请关闭旧版打卡助手后重新安装。'
  else if ExitCode <> 0 then
    Result := '旧版正在执行任务或尚未正常退出。请等待操作完成，再从旧版“偏好设置 → 退出程序”退出后重试。';
end;

function InitializeUninstall(): Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{app}\打卡助手.exe'), '--uninstall', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if Result then Result := ExitCode = 0;
  if not Result then MsgBox('无法正常退出打卡助手，请先在程序中退出后台，再重试卸载。', mbError, MB_OK);
end;
