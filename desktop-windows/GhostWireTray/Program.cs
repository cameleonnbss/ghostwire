using System.Diagnostics;
using Microsoft.Win32;

namespace GhostWireTray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

/// <summary>
/// Tray-application context: starts/stops the bundled GhostWire server,
/// opens the panel in the default browser, and can set/unset the
/// Windows system proxy to the local SOCKS/HTTP listener.
/// </summary>
public sealed partial class TrayContext : ApplicationContext
{
    private const string PanelUrl = "http://127.0.0.1:8080";
    private const string SocksProxy = "127.0.0.1:1080";

    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _proxyMenuItem;
    private Process? _server;
    private bool _proxyEnabled;

    public TrayContext()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add("Open panel", null, (_, _) => OpenPanel());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Start server", null, (_, _) => StartServer());
        menu.Items.Add("Stop server", null, (_, _) => StopServer());
        menu.Items.Add(new ToolStripSeparator());
        _proxyMenuItem = new ToolStripMenuItem("System proxy: OFF");
        _proxyMenuItem.Click += (_, _) => ToggleSystemProxy();
        menu.Items.Add(_proxyMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitTray());

        _tray = new NotifyIcon
        {
            Icon = GetIcon(),
            Text = "GhostWire",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => OpenPanel();

        StartServer();
    }

    private static Icon GetIcon()
    {
        // Fall back to the default app icon when the custom .ico is absent.
        try { return new Icon("app.ico"); }
        catch { return SystemIcons.Shield; }
    }

    private void OpenPanel()
    {
        try { Process.Start(new ProcessStartInfo(PanelUrl) { UseShellExecute = true }); }
        catch { MessageBox.Show($"Could not open {PanelUrl}", "GhostWire"); }
    }

    private void StartServer()
    {
        if (_server is { HasExited: false }) return;
        var exeDir = AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(exeDir, "server", "bin", "ghostwire.js"),
            Path.Combine(exeDir, "ghostwire", "bin", "ghostwire.js"),
            Path.Combine(exeDir, "..", "..", "..", "..", "bin", "ghostwire.js"), // dev checkout
        };
        var script = candidates.FirstOrDefault(File.Exists);
        if (script is null)
        {
            MessageBox.Show(
                "ghostwire.js was not found next to the app.\n" +
                "Keep the 'server' folder from the release bundle beside GhostWireTray.exe.",
                "GhostWire", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var workingDir = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(script)))!;
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = $"\"{script}\" start --port 8080",
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        _server = Process.Start(psi);
        _tray.ShowBalloonTip(2500, "GhostWire", $"Panel starting at {PanelUrl}", ToolTipIcon.Info);
    }

    private void StopServer()
    {
        if (_server is { HasExited: false })
        {
            _server.Kill(entireProcessTree: true);
            _tray.ShowBalloonTip(2000, "GhostWire", "Server stopped", ToolTipIcon.Info);
        }
        _server = null;
    }

    private void ToggleSystemProxy()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Internet Settings", writable: true)
                ?? throw new InvalidOperationException("Registry key not accessible");

            if (_proxyEnabled)
            {
                key.SetValue("ProxyEnable", 0, RegistryValueKind.DWord);
                key.DeleteValue("ProxyServer", throwOnMissingValue: false);
                _proxyEnabled = false;
            }
            else
            {
                key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
                key.SetValue("ProxyServer", SocksProxy, RegistryValueKind.String);
                key.SetValue("ProxyOverride", "localhost;127.*;192.168.*;<local>", RegistryValueKind.String);
                _proxyEnabled = true;
            }
            _proxyMenuItem.Text = _proxyEnabled ? "System proxy: ON" : "System proxy: OFF";

            NotifyProxyChange();
            _tray.ShowBalloonTip(2000, "GhostWire",
                _proxyEnabled ? $"System proxy set to {SocksProxy}" : "System proxy disabled",
                ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "GhostWire — proxy error",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void NotifyProxyChange()
    {
        // Broadcast WM_SETTINGCHANGE so WinINET picks up the new proxy.
        // P/Invoke kept tiny on purpose.
        _ = SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, UIntPtr.Zero, IntPtr.Zero,
            SMTO_ABORTIFHUNG, 2000, out _);
    }

    private void ExitTray()
    {
        StopServer();
        _tray.Visible = false;
        _tray.Dispose();
        Application.Exit();
    }

    // ── Win32 interop (proxy refresh broadcast) ──────────────────────────
    private const nint HWND_BROADCAST = 0xFFFF;
    private const uint WM_SETTINGCHANGE = 0x001A;
    private const uint SMTO_ABORTIFHUNG = 0x0002;

    [System.Runtime.InteropServices.LibraryImport("user32.dll", SetLastError = true)]
    private static partial nint SendMessageTimeout(nint hWnd, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
