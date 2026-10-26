using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ControlPlaneLockDelete {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct FileInformation {
    public uint Attributes;
    public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Disposition {
    [MarshalAs(UnmanagedType.Bool)] public bool Delete;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder volume, uint volumeSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(SafeFileHandle handle, byte[] bytes, uint length, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);

  public static Dictionary<string,object> Recover(string path, ulong volume, ulong id, string token, uint pid) {
    if (pid == 0 || String.IsNullOrEmpty(token)) return Result(false,"unavailable");
    using (SafeWaitHandle process = OpenProcess(0x00100000u, false, pid)) {
      if (process.IsInvalid) {
        if (Marshal.GetLastWin32Error() != 87) return Result(false,"unavailable");
      } else if (WaitForSingleObject(process,0) != 0) return Result(false,"owner_changed");
      // PID reuse cannot own the same UUID/file identity. Delete the verified handle only.
      return Remove(path,volume,id,token,null);
    }
  }

  static Dictionary<string,object> Result(bool removed, string reason) {
    return new Dictionary<string,object> { {"removed",removed}, {"reason",reason} };
  }
  // The optional callback is used only by deterministic adapter tests. Production passes null.
  public static Dictionary<string,object> Remove(string path, ulong expectedVolume, ulong expectedId, string expectedToken, Action afterIdentityCheck) {
    if (expectedId == 0 || !System.IO.Path.IsPathRooted(path) || System.IO.Path.GetFileName(path) != "instance.lock") return Result(false,"unavailable");
    // DELETE + GENERIC_READ + FILE_READ_ATTRIBUTES, share existing reader/writer/rename handles.
    // OPEN_REPARSE_POINT prevents a junction/symlink from redirecting the opened handle.
    using (SafeFileHandle handle = CreateFileW(path, 0x80010080u, 7u, IntPtr.Zero, 3u, 0x00200000u, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int code = Marshal.GetLastWin32Error();
        return Result(false, code == 2 || code == 3 ? "not_found" : "unavailable");
      }
      FileInformation info;
      if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x410u) != 0) return Result(false,"unavailable");
      var filesystem = new StringBuilder(32); uint serial, maxComponent, flags;
      if (!GetVolumeInformationByHandleW(handle, null, 0, out serial, out maxComponent, out flags, filesystem, 32) || filesystem.ToString() != "NTFS") return Result(false,"unavailable");
      ulong fileId = ((ulong)info.IndexHigh << 32) | info.IndexLow;
      if ((ulong)info.Volume != expectedVolume || fileId != expectedId) return Result(false,"owner_changed");
      if (!String.IsNullOrEmpty(expectedToken)) {
        var bytes = new byte[4097]; uint length;
        if (!ReadFile(handle, bytes, 4097, out length, IntPtr.Zero) || length > 4096) return Result(false,"unavailable");
        string text = Encoding.UTF8.GetString(bytes,0,(int)length);
        if (!text.Contains("\"token\":\"" + expectedToken + "\"")) return Result(false,"owner_changed");
      }
      if (afterIdentityCheck != null) afterIdentityCheck();
      var disposition = new Disposition { Delete = true };
      // Mark this verified handle, never resolve the pathname again for deletion.
      if (!SetFileInformationByHandle(handle,4,ref disposition,(uint)Marshal.SizeOf(typeof(Disposition)))) return Result(false,"unavailable");
      return Result(true,"removed");
    }
  }
}
