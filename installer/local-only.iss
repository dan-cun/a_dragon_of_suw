; Machine-only packaging; formal licensing gates remain unchanged.
#ifndef AppVersion
  #error AppVersion must be supplied explicitly
#endif
#ifndef WindowsVersion
  #error WindowsVersion must be supplied explicitly
#endif
#ifndef ProjectSource
  #error ProjectSource must be supplied explicitly
#endif
#ifndef SourceDir
  #error SourceDir must be supplied explicitly
#endif
#ifndef OutputPath
  #error OutputPath must be supplied explicitly
#endif

[Setup]
AppId={{D6FCA130-103B-4C33-B080-262012DA4B10}
AppName=西大日常（LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED）
AppVersion={#AppVersion}
AppPublisher=swu-daka contributors / dan-cun
DefaultDirName=C:\Users\ZhuangQ\AppData\Local\Programs\SWU-Daka
DefaultGroupName=西大日常
UsePreviousAppDir=no
UsePreviousGroup=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#ProjectSource}\assets\icon.ico
UninstallDisplayIcon={app}\打卡助手.exe
LicenseFile={#SourceDir}\LICENSE.txt
OutputDir={#OutputPath}
OutputBaseFilename=西大日常-{#AppVersion}-LOCAL_ONLY-TEST_ONLY-RELEASE_BLOCKED-本机安装程序
VersionInfoVersion={#WindowsVersion}
VersionInfoTextVersion={#AppVersion} LOCAL_ONLY TEST_ONLY RELEASE_BLOCKED
VersionInfoProductTextVersion={#AppVersion} LOCAL_ONLY TEST_ONLY RELEASE_BLOCKED
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
Uninstallable=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "{#ProjectSource}\installer\ChineseSimplified.isl"

[Files]
Source: "{#SourceDir}\打卡助手.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NOTICE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\DISCLAIMER.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LOCAL_ONLY_BUILD_INFO.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LOCAL_ONLY_TEST_ONLY_RELEASE_BLOCKED.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\modules\*"; DestDir: "{app}\modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\sources\*"; DestDir: "{app}\sources"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "C:\Users\ZhuangQ\Desktop\西大日常"; Filename: "{app}\打卡助手.exe"; WorkingDir: "{app}"; Comment: "LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED"
Name: "{group}\西大日常"; Filename: "{app}\打卡助手.exe"; WorkingDir: "{app}"; Comment: "LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{group}\卸载西大日常"; Filename: "{uninstallexe}"

[Code]
function CheckApplicationStopped(): String;
var
  Locator, Services, Processes: Variant;
begin
  Result := '';
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name=''打卡助手.exe''');
    if Processes.Count <> 0 then
      Result := '打卡助手仍在运行，请本人正常退出后重试；本机安装器不会自动关闭或强杀应用。';
    Log('LOCAL_ONLY passive occupancy check; no shutdown, process termination or application launch requested.');
  except
    Result := '无法确认应用已退出，已停止操作：' + GetExceptionMessage;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if CompareText(ExpandConstant('{app}'), 'C:\Users\ZhuangQ\AppData\Local\Programs\SWU-Daka') <> 0 then
  begin
    Result := '本机专用安装器不允许安装到其他目录。';
    Exit;
  end;
  Result := CheckApplicationStopped();
end;

function InitializeUninstall(): Boolean;
var
  Failure: String;
begin
  Failure := CheckApplicationStopped();
  Result := Failure = '';
  if not Result then MsgBox(Failure, mbError, MB_OK);
end;
