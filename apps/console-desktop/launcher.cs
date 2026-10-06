using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
[assembly: AssemblyTitle("WeChatAgent")]
[assembly: AssemblyDescription("WeChatAgent desktop application")]
[assembly: AssemblyProduct("WeChatAgent")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]

internal static class Launcher {
    [STAThread]
    private static void Main() {
        try {
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string application = Path.Combine(root, "release", "WeChatAgent", "WeChatAgent.exe");
            if (!File.Exists(application)) throw new FileNotFoundException("桌面程序尚未构建。请双击 WeChatAgent-Console.vbs 自动构建并启动。", application);
            ProcessStartInfo start = new ProcessStartInfo(application);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            start.EnvironmentVariables.Remove("PSModulePath");
            Process.Start(start);
        } catch (Exception error) {
            MessageBox.Show(error.Message, "WeChatAgent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
