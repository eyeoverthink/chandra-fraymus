// Synthetic UI Automation fixture. Reads only adjacent operator reference.json
// in no-argument mode. No writes, network, clipboard, or shell actions.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FraymusDesktopFixture
{
    internal sealed class FixtureWindow : Form
    {
        private readonly TextBox draft;
        private readonly Label status;
        private readonly Label generation;
        private readonly Label enabledState;
        private readonly FlowLayoutPanel targetPanel;
        private Button apply;
        private int targetGeneration = 1;
        private bool targetEnabled = true;

        internal FixtureWindow(string referenceNonce, string instanceId)
        {
            Name = "FraymusDesktopFixture";
            Text = "Fraymus Desktop Fixture | " + instanceId;
            AccessibleName = Text;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(820, 590);
            MinimumSize = new Size(760, 620);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Segoe UI", 10F);

            var layout = new TableLayoutPanel {
                Name = "FixtureLayout", Dock = DockStyle.Fill, Padding = new Padding(18),
                ColumnCount = 1, RowCount = 12
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            int[] heights = { 44, 26, 34, 26, 94, 26, 94, 35, 48, 45, 27, 30 };
            foreach (int height in heights) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            Controls.Add(layout);
            layout.Controls.Add(new Label {
                Name = "FixtureNotice", Text = "TEST ONLY - synthetic data. No writes, network, clipboard, or shell actions.",
                Dock = DockStyle.Fill, AutoSize = false, ForeColor = Color.DarkRed
            }, 0, 0);
            layout.Controls.Add(Caption("ReferenceCaption", "Synthetic reference nonce"), 0, 1);
            var nonce = TextControl("ReferenceNonce", true);
            nonce.AccessibleName = "Synthetic reference nonce (test only)";
            nonce.Text = referenceNonce;
            layout.Controls.Add(nonce, 0, 2);
            layout.Controls.Add(Caption("DraftCaption", "Draft (test only; Apply copies this text to Status)"), 0, 3);
            draft = TextControl("DraftInput", false);
            draft.AccessibleName = "Draft";
            draft.Multiline = true;
            draft.AcceptsReturn = true;
            draft.ScrollBars = ScrollBars.Vertical;
            draft.MaxLength = 4096;
            layout.Controls.Add(draft, 0, 4);
            layout.Controls.Add(Caption("StatusCaption", "Status - read-only exact applied draft text"), 0, 5);
            // Name supplies the stable AutomationId; the visible label text is
            // deliberately the complete draft, without an added status prefix.
            status = new Label {
                Name = "StatusOutput", Text = "Nothing applied.", Dock = DockStyle.Fill,
                AutoSize = false, BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(6),
                AccessibleDescription = "Read-only test result. Changes only after Apply Draft."
            };
            layout.Controls.Add(status, 0, 6);
            generation = Caption("GenerationOutput", "Target generation: 1");
            layout.Controls.Add(generation, 0, 7);
            targetPanel = new FlowLayoutPanel {
                Name = "TargetPanel", Dock = DockStyle.Fill, WrapContents = false
            };
            layout.Controls.Add(targetPanel, 0, 8);
            ReplaceApplyTarget();

            var controls = new FlowLayoutPanel { Name = "FixtureControls", Dock = DockStyle.Fill, WrapContents = false };
            var change = ButtonControl("ChangeTarget", "Change target");
            change.Click += delegate {
                targetGeneration++;
                ReplaceApplyTarget();
                generation.Text = "Target generation: " + targetGeneration;
            };
            controls.Controls.Add(change);
            var disable = ButtonControl("DisableTarget", "Disable target");
            disable.Click += delegate {
                targetEnabled = !targetEnabled;
                apply.Enabled = targetEnabled;
                disable.Text = targetEnabled ? "Disable target" : "Enable target";
                disable.AccessibleName = disable.Text;
                enabledState.Text = "Apply target enabled: " + (targetEnabled ? "true" : "false");
            };
            controls.Controls.Add(disable);
            var focus = ButtonControl("FocusSink", "Focus sink (test only)");
            // It intentionally has no action handler; clicking focuses this button.
            controls.Controls.Add(focus);
            var close = ButtonControl("CloseFixture", "Close fixture");
            close.Click += delegate { Close(); };
            controls.Controls.Add(close);
            layout.Controls.Add(controls, 0, 9);
            enabledState = Caption("TargetStateOutput", "Apply target enabled: true");
            layout.Controls.Add(enabledState, 0, 10);
            layout.Controls.Add(Caption("FixtureFooter", "Change target replaces Apply's native control; old snapshot targets must be rejected."), 0, 11);
        }

        private static Label Caption(string id, string text)
        {
            return new Label { Name = id, Text = text, Dock = DockStyle.Fill, AutoSize = false };
        }

        private static TextBox TextControl(string id, bool readOnly)
        {
            return new TextBox {
                Name = id, ReadOnly = readOnly, Dock = DockStyle.Fill,
                ShortcutsEnabled = false, AllowDrop = false,
                ContextMenu = new ContextMenu()
            };
        }

        private static Button ButtonControl(string id, string text)
        {
            return new Button {
                Name = id, Text = text, AccessibleName = text, AutoSize = true,
                Height = 34, Margin = new Padding(0, 0, 10, 0), Padding = new Padding(5, 3, 5, 3)
            };
        }

        private void ReplaceApplyTarget()
        {
            if (apply != null) {
                targetPanel.Controls.Remove(apply);
                apply.Dispose();
            }
            apply = ButtonControl("ApplyDraft", targetGeneration == 1 ? "Apply Draft" : "Apply Draft (generation " + targetGeneration + ")");
            apply.Enabled = targetEnabled;
            apply.Click += delegate { status.Text = draft.Text; };
            targetPanel.Controls.Add(apply);
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string referenceNonce = null, instanceId = null;
            if (args.Length == 0) {
                try {
                    // Fixed operator-created adjacent input only. Never search
                    // home/profile/config directories or accept an input path.
                    string input = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reference.json");
                    byte[] buffer = new byte[4097];
                    int count = 0;
                    using (var stream = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                        int read;
                        while (count < buffer.Length && (read = stream.Read(buffer, count, buffer.Length - count)) > 0) count += read;
                    }
                    if (count == 0 || count > 4096) throw new InvalidDataException();
                    string json = new UTF8Encoding(false, true).GetString(buffer, 0, count).TrimStart('\uFEFF');
                    var serializer = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
                    var config = serializer.DeserializeObject(json) as Dictionary<string, object>;
                    if (config == null || config.Count != 2 || !config.ContainsKey("referenceNonce") || !config.ContainsKey("instanceId")) throw new InvalidDataException();
                    referenceNonce = config["referenceNonce"] as string;
                    instanceId = config["instanceId"] as string;
                } catch {
                    Console.Error.WriteLine("A bounded adjacent test-only reference.json is required.");
                    return 2;
                }
            } else if (args.Length == 4 && args[0] == "--reference-nonce" && args[2] == "--instance-id") {
                referenceNonce = args[1]; instanceId = args[3];
            }
            if (referenceNonce == null || instanceId == null
                || !Regex.IsMatch(referenceNonce, "\\A[A-Za-z0-9._-]{8,128}\\z")
                || !Regex.IsMatch(instanceId, "\\A[A-Za-z0-9._-]{2,64}\\z")) {
                Console.Error.WriteLine("Supply a synthetic reference nonce and safe unique fixture instance ID.");
                return 2;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new FixtureWindow(referenceNonce, instanceId)) Application.Run(window);
            return 0;
        }
    }
}
