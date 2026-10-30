// Static programs: caller-controlled paths are passed as environment/argv data.
// Windows uses the Explorer common-item dialog, including on PowerShell 5.1.
// https://learn.microsoft.com/windows/win32/shell/common-file-dialog
export const WINDOWS_FOLDER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class LoomFolderDialog {
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint location);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint type, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem item, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = true)]
  private static extern int SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);

  public static string Select(string initial, bool display) {
    object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
    IFileDialog dialog = (IFileDialog) instance;
    IShellItem starting = null;
    IShellItem selected = null;
    IntPtr displayName = IntPtr.Zero;
    try {
      uint options;
      dialog.GetOptions(out options);
      // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT.
      dialog.SetOptions(options | 0x20u | 0x40u | 0x800u | 0x02000000u);
      dialog.SetTitle("Agent Loom - Select workspace folder");
      dialog.SetOkButtonLabel("Select folder");
      Guid client = new Guid("FC5F1C22-ECBC-4F22-A4C0-EDAE005DB2FA");
      dialog.SetClientGuid(ref client);
      if (!String.IsNullOrEmpty(initial) && Directory.Exists(initial)) {
        Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        int parsed = SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out starting);
        if (parsed >= 0) dialog.SetFolder(starting);
      }
      if (!display) {
        // CI exercises real COM setup and filesystem-item marshalling without Show.
        if (starting != null) starting.GetDisplayName(0x80058000u, out displayName);
        return null;
      }
      int result = dialog.Show(IntPtr.Zero);
      if (result == unchecked((int) 0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(result);
      dialog.GetResult(out selected);
      selected.GetDisplayName(0x80058000u, out displayName); // SIGDN_FILESYSPATH.
      return Marshal.PtrToStringUni(displayName);
    } finally {
      if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
      if (selected != null) Marshal.FinalReleaseComObject(selected);
      if (starting != null) Marshal.FinalReleaseComObject(starting);
      Marshal.FinalReleaseComObject(instance);
    }
  }
}
'@
$selected = [LoomFolderDialog]::Select($env:LOOM_FOLDER_PICKER_INITIAL_PATH, ($env:LOOM_FOLDER_PICKER_VALIDATE_ONLY -ne '1'))
[Console]::WriteLine((@{path = $selected} | ConvertTo-Json -Compress))
`;

// https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/PromptforaFileorFolder.html
export const MAC_FOLDER_SCRIPT = String.raw`
function run(argv) {
  if (argv[1] === 'validate') return JSON.stringify({path: null});
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var options = {withPrompt: 'Agent Loom - Select workspace folder'};
  if (argv[0]) options.defaultLocation = Path(argv[0]);
  try {
    app.activate();
    return JSON.stringify({path: app.chooseFolder(options).toString()});
  } catch (error) {
    if (error.errorNumber === -128 || error.number === -128) return JSON.stringify({path: null});
    throw error;
  }
}
`;
