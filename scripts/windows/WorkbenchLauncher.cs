using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// A native entry only. Installation, policy, recovery and service ownership remain in the existing manager.
internal static class WorkbenchLauncher
{
    [DataContract] private sealed class Inventory
    {
        [DataMember(Name = "files")] public Item[] Files { get; set; }
    }
    [DataContract] private sealed class Item
    {
        [DataMember(Name = "path")] public string Path { get; set; }
        [DataMember(Name = "size")] public long Size { get; set; }
        [DataMember(Name = "sha256")] public string Sha256 { get; set; }
    }
    [DataContract] private sealed class Installation
    {
        [DataMember(Name = "current")] public Selection Current { get; set; }
    }
    [DataContract] private sealed class Selection
    {
        [DataMember(Name = "configFile")] public string ConfigFile { get; set; }
        [DataMember(Name = "releaseId")] public string ReleaseId { get; set; }
    }
    [DataContract] private sealed class Configuration
    {
        [DataMember(Name = "port")] public int? Port { get; set; }
    }
    private sealed class Options
    {
        public string Directory = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MultiAgentControlPlane");
        public string Cache = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MultiAgentControlPlaneCache");
        public string Config;
        public bool Headless, NoShortcuts;
        public string Action = "open";
    }
    private static StreamWriter log;
    private static readonly object logGate = new object();
    private static Form form;
    private static Label status;
    private static int result;

    [STAThread] private static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        try { Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true }); } catch (IOException) { }
        Options options;
        try { options = Parse(args); }
        catch (Exception error) { if (Array.IndexOf(args, "--headless") < 0) MessageBox.Show(error.Message, "Hermes 工作台"); return 1; }
        if (options.Headless) return Run(options);
        Application.EnableVisualStyles();
        form = new Form { Text = "Hermes 工作台", ClientSize = new Size(490, 135), StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = true, ControlBox = false };
        status = new Label { Text = "正在准备工作台，请稍候…", Location = new Point(24, 24), Size = new Size(442, 52) };
        form.Controls.Add(status);
        form.Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, Location = new Point(24, 91), Size = new Size(442, 16) });
        form.Shown += delegate {
            var worker = new Thread(delegate() {
                result = Run(options);
                form.BeginInvoke(new Action(delegate { form.Close(); }));
            }) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
        };
        Application.Run(form);
        return result;
    }
    private static Options Parse(string[] args)
    {
        var options = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--headless") options.Headless = true;
            else if (args[i] == "--no-shortcuts") options.NoShortcuts = true;
            else if (args[i] == "--stop" || args[i] == "--status") options.Action = args[i].Substring(2);
            else if ((args[i] == "--directory" || args[i] == "--cache" || args[i] == "--config") && i + 1 < args.Length)
            {
                string key = args[i++], value = System.IO.Path.GetFullPath(args[i]);
                if (key == "--directory") options.Directory = value;
                else if (key == "--cache") options.Cache = value;
                else options.Config = value;
            }
            else throw new ArgumentException("支持直接打开，或 --headless、--stop、--status、--directory 路径、--cache 路径。");
        }
        options.Directory = System.IO.Path.GetFullPath(options.Directory);
        options.Cache = System.IO.Path.GetFullPath(options.Cache);
        if (Inside(options.Directory, options.Cache) || Inside(options.Cache, options.Directory) || Equal(options.Directory, options.Cache))
            throw new ArgumentException("程序缓存与安装目录必须分开，原文件保留。");
        return options;
    }
    private static int Run(Options options)
    {
        string logFile = null;
        try
        {
            string cache = LongPath(options.Cache);
            OrdinaryDirectory(cache);
            string logs = System.IO.Path.Combine(cache, "logs");
            OrdinaryDirectory(logs);
            logFile = System.IO.Path.Combine(logs, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N") + ".log");
            using (log = new StreamWriter(new FileStream(logFile, FileMode.CreateNew), new UTF8Encoding(false)))
            using (var mutex = new Mutex(false, "Local\\HermesWorkbench-" + HashText(options.Directory.ToUpperInvariant()).Substring(0, 32)))
            {
                bool owned;
                Progress("正在检查本机工作台…");
                try { owned = mutex.WaitOne(TimeSpan.FromMinutes(3)); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) throw new IOException("另一处启动或安装仍在进行，请稍候再打开。");
                try
                {
                    if (options.Action != "open")
                    {
                        string manager = System.IO.Path.Combine(options.Directory, "launcher", "control-plane.mjs");
                        if (!File.Exists(System.IO.Path.Combine(options.Directory, "installation.json"))) { Progress("尚未安装工作台。"); return 0; }
                        return Node(System.IO.Path.Combine(options.Directory, "runtime", "node.exe"), new[] { manager, options.Action }, options.Directory);
                    }
                    string package = NormalPath(PreparePackage(cache));
                    var arguments = new List<string> { System.IO.Path.Combine(package, "launcher", "control-plane.mjs"), "open-package", "--release", package,
                        "--directory", options.Directory, "--upgrade-if-newer" };
                    if (options.Config != null) { arguments.Add("--config"); arguments.Add(options.Config); }
                    arguments.Add("--headless");
                    Progress("正在安装、检查更新并打开工作台…");
                    int code = Node(System.IO.Path.Combine(package, "runtime", "node.exe"), arguments.ToArray(), package);
                    if (code != 0) throw new IOException("工作台准备未完成。请查看下方日志中的具体原因，原程序和数据均保留。");
                    string selectedRelease;
                    string url = BrowserUrl(options.Directory, out selectedRelease);
                    Progress("工作台地址：" + url);
                    string installed = System.IO.Path.Combine(options.Directory, "工作台.exe");
                    try
                    {
                        if (!File.Exists(installed) || (selectedRelease == PayloadInfo.ReleaseId && !Equal(installed, Assembly.GetExecutingAssembly().Location) && FileHash(installed) != FileHash(Assembly.GetExecutingAssembly().Location)))
                        {
                            string temporary = installed + ".incoming-" + Guid.NewGuid().ToString("N");
                            File.Copy(Assembly.GetExecutingAssembly().Location, temporary, false);
                            if (File.Exists(installed)) File.Replace(temporary, installed, installed + ".previous-" + Guid.NewGuid().ToString("N"));
                            else File.Move(temporary, installed);
                        }
                    }
                    catch { Progress("工作台已就绪；固定入口未能保存，可继续使用当前 EXE。"); }
                    if (!options.Headless && !options.NoShortcuts && File.Exists(installed)) Shortcut(installed);
                    if (!options.Headless)
                    {
                        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
                        catch (Exception error) { throw new IOException("工作台已在后台启动，但浏览器未能打开。请访问：" + url, error); }
                    }
                    Progress("工作台已就绪。");
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            log = null;
            if (logFile != null) try { File.AppendAllText(logFile, error.ToString() + Environment.NewLine, new UTF8Encoding(false)); } catch (IOException) { }
            Progress("启动未完成：" + error.Message);
            if (!options.Headless)
                MessageBox.Show("启动未完成：" + error.Message + (logFile == null ? "" : "\n\n诊断日志：" + NormalPath(logFile)), "Hermes 工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally { log = null; }
    }
    private static string PreparePackage(string cache)
    {
        using (var mutex = new Mutex(false, "Local\\HermesWorkbenchCache-" + HashText(cache.ToUpperInvariant()).Substring(0, 32)))
        {
            bool owned;
            try { owned = mutex.WaitOne(TimeSpan.FromMinutes(3)); } catch (AbandonedMutexException) { owned = true; }
            if (!owned) throw new IOException("程序缓存正在准备，请稍候再打开。");
            try { return PrepareOwnedPackage(cache); } finally { mutex.ReleaseMutex(); }
        }
    }
    private static string BrowserUrl(string directory, out string selectedRelease)
    {
        Installation installation;
        using (Stream input = File.OpenRead(LongPath(System.IO.Path.Combine(directory, "installation.json"))))
            installation = (Installation)new DataContractJsonSerializer(typeof(Installation)).ReadObject(input);
        if (installation.Current == null || String.IsNullOrEmpty(installation.Current.ConfigFile) || !System.IO.Path.IsPathRooted(installation.Current.ConfigFile)) throw new IOException("安装配置尚未就绪。");
        selectedRelease = installation.Current.ReleaseId;
        Configuration configuration;
        using (Stream input = File.OpenRead(LongPath(installation.Current.ConfigFile)))
            configuration = (Configuration)new DataContractJsonSerializer(typeof(Configuration)).ReadObject(input);
        int port = configuration.Port ?? 3000;
        if (port < 1 || port > 65535) throw new IOException("启动地址无效。");
        return "http://127.0.0.1:" + port + "/";
    }
    private static string PrepareOwnedPackage(string cache)
    {
        string root = System.IO.Path.Combine(cache, "packages");
        OrdinaryDirectory(root);
        string pointer = System.IO.Path.Combine(root, PayloadInfo.ReleaseId + ".ready");
        string name = PayloadInfo.ReleaseId;
        if (File.Exists(pointer))
        {
            string selected = File.ReadAllText(pointer, Encoding.UTF8).Trim();
            if ((selected == PayloadInfo.ReleaseId || selected.StartsWith(PayloadInfo.ReleaseId + ".repair-", StringComparison.Ordinal)) &&
                selected.IndexOfAny(new[] { '/', '\\', ':' }) < 0 && selected.Length <= PayloadInfo.ReleaseId.Length + 40)
                name = selected;
        }
        string package = System.IO.Path.Combine(root, name);
        if (Directory.Exists(package))
        {
            Progress("正在核对已有程序文件…");
            try { Verify(package); return package; }
            catch (Exception error)
            {
                // A running background launcher can retain its working directory. Keep it in place.
                Progress("程序缓存需要重新准备：" + error.Message);
                name = PayloadInfo.ReleaseId + ".repair-" + Guid.NewGuid().ToString("N");
                package = System.IO.Path.Combine(root, name);
                Progress("原缓存不完整，已保留，正在准备新副本…");
            }
        }
        string staging = System.IO.Path.Combine(root, ".incoming-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Hermes.Payload.zip"))
        {
            if (payload == null || Hash(payload) != PayloadInfo.PayloadSha256) throw new IOException("内置程序包校验失败，请重新下载完整 EXE。");
            payload.Position = 0;
            Progress("首次运行，正在展开内置程序和运行环境…");
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read, true))
            {
                if (zip.Entries.Count > 100000) throw new IOException("程序包条目过多。");
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long total = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string file = Owned(staging, entry.FullName);
                    if (!seen.Add(file) || entry.Length < 0 || (total += entry.Length) > 2147483648L) throw new IOException("程序包条目无效。");
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));
                    using (Stream source = entry.Open())
                    using (var target = new FileStream(file, FileMode.CreateNew, FileAccess.Write)) source.CopyTo(target);
                }
            }
        }
        Verify(staging);
        Directory.Move(staging, package);
        string pending = pointer + ".incoming-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(pending, name, new UTF8Encoding(false));
        if (File.Exists(pointer)) File.Replace(pending, pointer, pointer + ".previous-" + Guid.NewGuid().ToString("N"));
        else File.Move(pending, pointer);
        return package;
    }
    private static void Verify(string package)
    {
        OrdinaryDirectory(package);
        string manifest = System.IO.Path.Combine(package, "release-manifest.json");
        if (FileHash(manifest) != PayloadInfo.ReleaseId || new FileInfo(manifest).Length > 16777216) throw new IOException("程序清单不符。");
        Inventory inventory;
        using (var input = File.OpenRead(manifest)) inventory = (Inventory)new DataContractJsonSerializer(typeof(Inventory)).ReadObject(input);
        if (inventory.Files == null || inventory.Files.Length == 0 || inventory.Files.Length > 100000) throw new IOException("程序清单无效。");
        var expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { manifest };
        foreach (Item item in inventory.Files)
        {
            string file = Owned(package, item.Path);
            if (!expected.Add(file)) throw new IOException("程序清单含重复文件。");
        }
        VerifyTree(package, expected);
        foreach (Item item in inventory.Files)
        {
            string file = Owned(package, item.Path);
            if (!File.Exists(file) || new FileInfo(file).Length != item.Size || FileHash(file) != item.Sha256) throw new IOException("程序文件不完整：" + item.Path);
        }
    }
    private static void VerifyTree(string directory, HashSet<string> expected)
    {
        OrdinaryDirectory(directory);
        foreach (string file in Directory.GetFiles(directory))
            if (!expected.Contains(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序缓存含未知文件或链接。");
        foreach (string child in Directory.GetDirectories(directory)) VerifyTree(child, expected);
    }
    private static string Owned(string root, string name)
    {
        if (String.IsNullOrEmpty(name) || name.IndexOf(':') >= 0 || name.IndexOf('\\') >= 0 || System.IO.Path.IsPathRooted(name)) throw new IOException("程序包路径无效。");
        foreach (string segment in name.Split('/'))
            if (segment == "" || segment == "." || segment == ".." || segment.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0) throw new IOException("程序包路径无效。");
        string file = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, name.Replace('/', System.IO.Path.DirectorySeparatorChar)));
        if (!Inside(root, file)) throw new IOException("程序包路径越界。");
        return file;
    }
    private static bool Equal(string a, string b) { return String.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
    private static string LongPath(string value)
    {
        if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) return value;
        string full = System.IO.Path.GetFullPath(value);
        return full.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + full.Substring(2) : "\\\\?\\" + full;
    }
    private static string NormalPath(string value)
    {
        if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + value.Substring(8);
        return value.StartsWith("\\\\?\\", StringComparison.Ordinal) ? value.Substring(4) : value;
    }
    private static bool Inside(string root, string file) { return file.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
    private static void OrdinaryDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序目录不能是链接。");
    }
    private static string FileHash(string file)
    {
        file = LongPath(file);
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序文件不能是链接。");
        using (Stream input = File.OpenRead(file)) return Hash(input);
    }
    private static string Hash(Stream input)
    { using (var algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(input)).Replace("-", "").ToLowerInvariant(); }
    private static string HashText(string input)
    { using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(input))) return Hash(stream); }
    private static string Quote(string input)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in input)
        {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(value); }
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static int Node(string executable, string[] args, string cwd)
    {
        if (FileHash(executable) != PayloadInfo.NodeSha256) throw new IOException("配套运行时校验失败。");
        var quoted = new List<string>(); foreach (string arg in args) quoted.Add(Quote(arg));
        var info = new ProcessStartInfo(executable, String.Join(" ", quoted)) { WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        // Ambient Node hooks must not turn a packaged startup into an unrelated script runner.
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        info.EnvironmentVariables.Remove("NODE_PATH");
        using (Process process = Process.Start(info))
        {
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Progress(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Progress(e.Data); };
            process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
            return process.ExitCode;
        }
    }
    private static void Shortcut(string installed)
    {
        try
        {
            string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { System.IO.Path.Combine(startMenu, "Hermes 工作台.lnk") });
            Type type = shortcut.GetType();
            type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { installed });
            type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { System.IO.Path.GetDirectoryName(installed) });
            type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch { Progress("工作台已启动；开始菜单入口未能创建，可继续使用当前 EXE。"); }
    }
    private static void Progress(string message)
    {
        try { Console.WriteLine(message); } catch (IOException) { }
        lock (logGate) { if (log != null) try { log.WriteLine(message); log.Flush(); } catch (ObjectDisposedException) { } }
        if (form != null && form.IsHandleCreated && !form.IsDisposed)
            try { form.BeginInvoke(new Action(delegate { status.Text = message; })); } catch (InvalidOperationException) { }
    }
}
