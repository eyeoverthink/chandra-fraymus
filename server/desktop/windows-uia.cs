// Trusted fixed UIA implementation. No script evaluation, focus changes, global
// input, desktop capture, browser profile access or arbitrary process attachment.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Fraymus {
 public static class Desktop {
  const int MaxNodes=256, MaxVisited=2048, MaxDepth=24, MaxPixels=2073600, MaxPng=4194304;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=8388608, RecursionLimit=64 };
  static readonly HashSet<string> Denied = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
   "cmd.exe","powershell.exe","pwsh.exe","windowsterminal.exe","wt.exe","conhost.exe","openconsole.exe",
   "consent.exe","credentialuibroker.exe","logonui.exe","winlogon.exe","taskmgr.exe","regedit.exe","mmc.exe",
   "control.exe","systemsettings.exe","rundll32.exe","wscript.exe","cscript.exe","mshta.exe","msiexec.exe",
   "explorer.exe","node.exe","python.exe","pythonw.exe","code.exe","codex.exe","chandra.exe",
   "chrome.exe","msedge.exe","firefox.exe","brave.exe" };
  class Denial : Exception { public string Code; public string[] Supported; public bool? ReadOnly; public Denial(string code) { Code=code; } }
  class Proc { public int Pid; public string Start,Path; }
  class Window { public IntPtr Hwnd; public Proc Process; public string Title; public RECT Bounds; }
  class NativeEdit { public IntPtr Hwnd;public uint Style;public string ClassName,Value;public Dictionary<string,object> Proof; }
  class NativeMessageFailure : Exception { public uint Error;public NativeMessageFailure(uint error) { Error=error; } }
  class Item { public AutomationElement Element; public int Depth,Parent; public Item(AutomationElement e,int d,int p) { Element=e;Depth=d;Parent=p; } }
  class View {
   public Window Window; public List<Dictionary<string,object>> All=new List<Dictionary<string,object>>();
   public List<AutomationElement> Elements=new List<AutomationElement>(); public List<Rectangle> Passwords=new List<Rectangle>();
   public bool Complete=true,SafetyBlocked=false; public Dictionary<string,object> Result;
  }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROCESSENTRY32 {
   public uint Size,Usage,Pid; public IntPtr Heap; public uint Module,Threads,Parent; public int Priority; public uint Flags;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
  }
  delegate bool EnumProc(IntPtr hwnd,IntPtr extra);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr extra);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowUnicode(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="GetClassNameW")] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int capacity);
  [DllImport("user32.dll",SetLastError=true,EntryPoint="GetWindowLongPtrW")] static extern IntPtr WindowLong64(IntPtr hwnd,int index);
  [DllImport("user32.dll",SetLastError=true,EntryPoint="GetWindowLongW")] static extern int WindowLong32(IntPtr hwnd,int index);
  [DllImport("kernel32.dll",EntryPoint="SetLastError")] static extern void ClearLastError(uint error);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeTextLength(IntPtr hwnd,uint message,UIntPtr wparam,IntPtr lparam,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeTextRead(IntPtr hwnd,uint message,UIntPtr wparam,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeTextWrite(IntPtr hwnd,uint message,UIntPtr wparam,string text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr root,IntPtr child);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref POINT point);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
  [DllImport("user32.dll",SetLastError=true)] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref int length);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out FILETIME create,out FILETIME exit,out FILETIME kernel,out FILETIME user);
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid,out uint session);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot,ref PROCESSENTRY32 item);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot,ref PROCESSENTRY32 item);

  static Dictionary<string,object> Obj(params object[] values) {
   var result=new Dictionary<string,object>(); for(int i=0;i<values.Length;i+=2) result[(string)values[i]]=values[i+1]; return result;
  }
  static string Str(Dictionary<string,object> value,string key) { object item; return value.TryGetValue(key,out item) && item is string ? (string)item : null; }
  static Dictionary<string,object> Map(Dictionary<string,object> value,string key) { object item; return value.TryGetValue(key,out item) ? item as Dictionary<string,object> : null; }
  static bool Bool(Dictionary<string,object> value,string key) { object item; return value.TryGetValue(key,out item) && item is bool && (bool)item; }
  static void Need(bool condition,string code) { if(!condition) throw new Denial(code); }
  static string Hash(string value) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(new UTF8Encoding(false,true).GetBytes(value))).Replace("-","").ToLowerInvariant(); }
  static string Cut(string value,int length) { if(value==null)return ""; value=Regex.Replace(value,@"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"," "); if(value.Length<=length)return value; int count=length; if(char.IsHighSurrogate(value[count-1]))count--; return value.Substring(0,count); }
  static bool SafeTitle(string title) { return !Regex.IsMatch(title,@"\b(chandra|myaipartner|codex|windows security|user account control)\b",RegexOptions.IgnoreCase); }
  static bool Sensitive(string name,string automationId) { return Regex.IsMatch(name+" "+automationId,@"\b(password|passcode|credential|secret|api[ _-]?key|access[ _-]?token)\b",RegexOptions.IgnoreCase); }
  static bool Restricted(string name,string automationId) { return Regex.IsMatch(name+" "+automationId,@"\b(approve|approval|allow|authorize|grant|permission|terminal|console|powershell|command prompt|run command|settings|security)\b",RegexOptions.IgnoreCase); }
  static Proc ProcessIdentity(int pid) {
   IntPtr handle=OpenProcess(0x1000,false,(uint)pid), token=IntPtr.Zero;
   Need(handle!=IntPtr.Zero,"desktop_denied");
   try {
    uint sourceSession,currentSession; Need(ProcessIdToSessionId((uint)pid,out sourceSession) && ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id,out currentSession) && sourceSession==currentSession,"desktop_denied");
    Need(OpenProcessToken(handle,8,out token),"desktop_denied");
    using(var owner=new WindowsIdentity(token)) Need(owner.User.Equals(WindowsIdentity.GetCurrent().User),"desktop_denied");
    var path=new StringBuilder(32768); int length=path.Capacity; FILETIME created=new FILETIME(),exit=new FILETIME(),kernel=new FILETIME(),user=new FILETIME();
    Need(QueryFullProcessImageName(handle,0,path,ref length) && GetProcessTimes(handle,out created,out exit,out kernel,out user),"desktop_denied");
    string image=System.IO.Path.GetFullPath(path.ToString()); Need(!Denied.Contains(System.IO.Path.GetFileName(image)),"desktop_denied");
    return new Proc { Pid=pid,Path=image,Start=(((ulong)created.High<<32)|created.Low).ToString(CultureInfo.InvariantCulture) };
   } finally { if(token!=IntPtr.Zero)CloseHandle(token); CloseHandle(handle); }
  }
  static HashSet<string> Allowlist(Dictionary<string,object> request) {
   object raw; Need(request.TryGetValue("allowlist",out raw) && raw is object[],"desktop_denied"); var result=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(object entry in (object[])raw) { string value=entry as string; Need(value!=null && value.Length<1025 && System.IO.Path.IsPathRooted(value) && !value.StartsWith(@"\\") && System.IO.Path.GetExtension(value).Equals(".exe",StringComparison.OrdinalIgnoreCase) && !Denied.Contains(System.IO.Path.GetFileName(value)),"desktop_denied"); result.Add(System.IO.Path.GetFullPath(value)); }
   Need(result.Count>0 && result.Count<=16,"desktop_denied"); return result;
  }
  static Window WindowIdentity(IntPtr hwnd,HashSet<string> allowed,Dictionary<string,object> expected) {
   Need(IsWindow(hwnd) && IsWindowVisible(hwnd) && !IsIconic(hwnd),"desktop_not_visible"); uint pid; GetWindowThreadProcessId(hwnd,out pid);
   var process=ProcessIdentity((int)pid); Need(allowed.Contains(process.Path),"desktop_denied");
   var title=new StringBuilder(401); GetWindowText(hwnd,title,title.Capacity); Need(SafeTitle(title.ToString()),"desktop_denied"); RECT bounds;
   Need(GetWindowRect(hwnd,out bounds) && bounds.Right>bounds.Left && bounds.Bottom>bounds.Top,"desktop_not_visible");
   if(expected!=null) Need(Str(expected,"hwnd")==hwnd.ToInt64().ToString(CultureInfo.InvariantCulture) && Convert.ToInt32(expected["pid"],CultureInfo.InvariantCulture)==process.Pid && Str(expected,"creationTime")==process.Start && String.Equals(Str(expected,"executable"),process.Path,StringComparison.OrdinalIgnoreCase),"desktop_stale");
   return new Window { Hwnd=hwnd,Process=process,Title=title.ToString(),Bounds=bounds };
  }
  static Dictionary<string,object> WindowJson(Window value) { return Obj("hwnd",value.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",value.Process.Pid,"creationTime",value.Process.Start,"executable",value.Process.Path,"title",value.Title); }
  static Dictionary<string,object> Bounds(RECT rect) { return Obj("x",rect.Left,"y",rect.Top,"width",rect.Right-rect.Left,"height",rect.Bottom-rect.Top); }
  static IntPtr Hwnd(Dictionary<string,object> target) { long value=0; Need(target!=null && Int64.TryParse(Str(target,"hwnd"),NumberStyles.None,CultureInfo.InvariantCulture,out value) && value>0,"desktop_denied"); return new IntPtr(value); }
  static Dictionary<int,int> Parents() {
   IntPtr snapshot=CreateToolhelp32Snapshot(2,0); Need(snapshot!=new IntPtr(-1),"desktop_denied"); var result=new Dictionary<int,int>();
   try { var item=new PROCESSENTRY32(); item.Size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY32)); int count=0;
    if(Process32First(snapshot,ref item)) do { Need(++count<=8192,"desktop_denied"); result[(int)item.Pid]=(int)item.Parent; } while(Process32Next(snapshot,ref item));
   } finally { CloseHandle(snapshot); } return result;
  }
  static bool Descendant(int pid,int root,Dictionary<int,int> parents) { var seen=new HashSet<int>(); for(int i=0;i<16 && seen.Add(pid);i++) { if(pid==root)return true; if(!parents.TryGetValue(pid,out pid))return false; } return false; }
  static string ElementHash(Dictionary<string,object> element) {
   var stable=new Dictionary<string,object>(element);
   // Full raw MSAA state is retained for diagnostics. Focus/selection/hottracking
   // bits cannot stale a semantic background action merely because approval took focus.
   if(stable.ContainsKey("legacyState"))stable["legacyState"]=Convert.ToUInt32(stable["legacyState"],CultureInfo.InvariantCulture)&DesktopTextPolicy.SafetyStateMask;
   return Hash(Json.Serialize(stable));
  }
  static bool? TextReadOnly(AutomationElement element) {
   object raw;if(!element.TryGetCurrentPattern(TextPattern.Pattern,out raw))return null;
   object attribute=((TextPattern)raw).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
   // MixedAttributeValue, NotSupported, missing and non-boolean provider values
   // are unknown; never coerce them into writable=false.
   return attribute is bool ? (bool?)attribute : null;
  }
  // This explicit adapter is only for a real same-process native child EDIT.
  // WM_* values, timeout and flags are trusted constants, never request fields.
  static NativeEdit NativeEditWindow(Window window,AutomationElement element) {
   WindowIdentity(window.Hwnd,new HashSet<string>(new string[] {window.Process.Path},StringComparer.OrdinalIgnoreCase),WindowJson(window));
   var current=element.Current;var hwnd=new IntPtr(unchecked((long)(uint)current.NativeWindowHandle));
   if(hwnd==IntPtr.Zero || hwnd==window.Hwnd || !IsWindow(hwnd))return null;
   uint pid;GetWindowThreadProcessId(hwnd,out pid);
   var name=new StringBuilder(256);int count=GetClassName(hwnd,name,name.Capacity);if(count<=0 || count>=255)return null;
   if(!DesktopNativeEditPolicy.BasicClass(name.ToString()) || pid!=(uint)window.Process.Pid || !IsChild(window.Hwnd,hwnd) || GetAncestor(hwnd,2)!=window.Hwnd)return null;
   ClearLastError(0);long raw=IntPtr.Size==8 ? WindowLong64(hwnd,-16).ToInt64() : WindowLong32(hwnd,-16);int last=Marshal.GetLastWin32Error();
   if(raw==0 && last!=0)throw new NativeMessageFailure(unchecked((uint)last));uint style=unchecked((uint)raw);
   var process=ProcessIdentity((int)pid);Need(process.Start==window.Process.Start && String.Equals(process.Path,window.Process.Path,StringComparison.OrdinalIgnoreCase),"desktop_stale");
   var fromHandle=AutomationElement.FromHandle(hwnd);Need(fromHandle!=null && fromHandle.GetRuntimeId().SequenceEqual(element.GetRuntimeId()),"desktop_stale");
   return new NativeEdit { Hwnd=hwnd,Style=style,ClassName=name.ToString(),Proof=Obj("hwnd",hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),"rootHwnd",window.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
    "pid",process.Pid,"creationTime",process.Start,"className",name.ToString(),"style",style,"unicode",IsWindowUnicode(hwnd)) };
  }
  static NativeEdit NativeEditIdentity(Window window,AutomationElement element,bool readOnly,LegacyText legacy) {
   var edit=NativeEditWindow(window,element);if(edit==null || !Bool(edit.Proof,"unicode"))return null;
   // Check actual password styles before any semantic text getter in this path.
   if((edit.Style & DesktopNativeEditPolicy.Password)!=0)return null;
   var current=element.Current;object valuePattern;bool actualReadOnly=readOnly || (element.TryGetCurrentPattern(ValuePattern.Pattern,out valuePattern) && ((ValuePattern)valuePattern).Current.IsReadOnly);
   bool? textReadOnly=TextReadOnly(element);uint legacyState=0;
   if(legacy!=null) { legacy.RefreshState();Need(legacy.Matches(element),"desktop_stale");legacyState=legacy.State; }
   if(!DesktopNativeEditPolicy.Eligible(current.ControlType.Id,edit.ClassName,edit.Style,true,true,true,
     current.IsEnabled && IsWindowEnabled(edit.Hwnd),IsWindowVisible(edit.Hwnd),current.IsOffscreen,current.IsPassword,actualReadOnly,textReadOnly,legacyState))return null;
   return edit;
  }
  static ulong NativeLength(IntPtr hwnd) {
   UIntPtr result;ClearLastError(0);
   if(NativeTextLength(hwnd,0x000e,UIntPtr.Zero,IntPtr.Zero,0x22,500,out result)==IntPtr.Zero)throw new NativeMessageFailure(unchecked((uint)Marshal.GetLastWin32Error()));
   return result.ToUInt64();
  }
  static string ReadNativeEdit(Window window,AutomationElement element,NativeEdit edit,bool readOnly,LegacyText legacy) {
   var fresh=NativeEditIdentity(window,element,readOnly,legacy);Need(fresh!=null && Json.Serialize(fresh.Proof)==Json.Serialize(edit.Proof),"desktop_stale");
   ulong length=NativeLength(edit.Hwnd);Need(length<=32767,"desktop_denied");
   fresh=NativeEditIdentity(window,element,readOnly,legacy);Need(fresh!=null && Json.Serialize(fresh.Proof)==Json.Serialize(edit.Proof),"desktop_stale");
   var text=new StringBuilder(32768);UIntPtr copied;ClearLastError(0);
   if(NativeTextRead(edit.Hwnd,0x000d,new UIntPtr(32768),text,0x22,500,out copied)==IntPtr.Zero)throw new NativeMessageFailure(unchecked((uint)Marshal.GetLastWin32Error()));
   string value=text.ToString();Need(copied.ToUInt64()<=32767 && copied.ToUInt64()==(ulong)value.Length && (ulong)value.Length==length,"desktop_stale");
   fresh=NativeEditIdentity(window,element,readOnly,legacy);Need(fresh!=null && Json.Serialize(fresh.Proof)==Json.Serialize(edit.Proof) && NativeLength(edit.Hwnd)==length,"desktop_stale");
   fresh=NativeEditIdentity(window,element,readOnly,legacy);Need(fresh!=null && Json.Serialize(fresh.Proof)==Json.Serialize(edit.Proof),"desktop_stale");
   Hash(value); // Strict UTF-8 rejects unpaired surrogates instead of replacement-hash collisions.
   return value;
  }
  static Dictionary<string,object> NativeEditProof(NativeEdit edit) { var result=new Dictionary<string,object>(edit.Proof);result["valueSha256"]=Hash(edit.Value);result["valueChars"]=edit.Value.Length;return result; }
  static bool NativeEditMatches(NativeEdit edit,Dictionary<string,object> proof) {
   if(edit==null || proof==null)return false;
   foreach(var pair in edit.Proof) { object value;if(!proof.TryGetValue(pair.Key,out value) || Convert.ToString(value,CultureInfo.InvariantCulture)!=Convert.ToString(pair.Value,CultureInfo.InvariantCulture))return false; }
   return true;
  }
  static View Observe(Window window,bool capture) {
   var view=new View { Window=window }; var processCache=new Dictionary<int,Proc>(); processCache[window.Process.Pid]=window.Process;
   var parents=Parents(); var root=AutomationElement.FromHandle(window.Hwnd); Need(root!=null,"desktop_element_unavailable");
   using(var textScope=new NativeTextScope(window.Hwnd)) {
   var stack=new Stack<Item>(); stack.Push(new Item(root,0,-1)); int visited=0; var fingerprint=new StringBuilder(); bool approveButton=false,rejectButton=false;
   while(stack.Count>0) {
    if(++visited>MaxVisited) { view.Complete=false; break; }
    Item work=stack.Pop(); var element=work.Element; var current=element.Current;
    if(current.IsOffscreen)continue;
    Proc owner; if(!processCache.TryGetValue(current.ProcessId,out owner)) { owner=ProcessIdentity(current.ProcessId); processCache[current.ProcessId]=owner; }
    Need(String.Equals(owner.Path,window.Process.Path,StringComparison.OrdinalIgnoreCase) && Descendant(owner.Pid,window.Process.Pid,parents),"desktop_denied");
    IntPtr native=new IntPtr(current.NativeWindowHandle); Need(native==IntPtr.Zero || native==window.Hwnd || IsChild(window.Hwnd,native),"desktop_denied");
    var rect=current.BoundingRectangle; if(rect.IsEmpty || Double.IsInfinity(rect.Width) || Double.IsNaN(rect.Width)) { if(current.IsPassword)view.Complete=false; continue; }
    var area=new Rectangle((int)Math.Floor(rect.X)-window.Bounds.Left,(int)Math.Floor(rect.Y)-window.Bounds.Top,(int)Math.Ceiling(rect.Width),(int)Math.Ceiling(rect.Height));
    area.Intersect(new Rectangle(0,0,window.Bounds.Right-window.Bounds.Left,window.Bounds.Bottom-window.Bounds.Top)); if(area.Width<=0 || area.Height<=0)continue;
    string name=current.Name ?? "", automationId=current.AutomationId ?? "";
    bool button=current.ControlType==ControlType.Button;
    // Any visible approval/permission control blocks the entire selected context,
    // including when an account app hosts Chandra's own approval page internally.
    if(button && Regex.IsMatch(name,@"^\s*(?:(approve|reject|allow|grant|authorize|deny)\b|always allow\b|run (once|this action|command)\b)",RegexOptions.IgnoreCase))view.SafetyBlocked=true;
    if(button && Regex.IsMatch(name,@"^\s*approve\s*$",RegexOptions.IgnoreCase))approveButton=true;
    if(button && Regex.IsMatch(name,@"^\s*reject\s*$",RegexOptions.IgnoreCase))rejectButton=true;
    if(current.ControlType==ControlType.Window && Regex.IsMatch(name,@"\b(windows security|user account control|permission|security warning|administrator approval)\b",RegexOptions.IgnoreCase))view.SafetyBlocked=true;
    if((current.ControlType==ControlType.Window || current.ControlType==ControlType.Pane || current.ControlType==ControlType.Group || current.ControlType==ControlType.Tab) && Regex.IsMatch(name,@"^\s*(settings|preferences|permissions|security|credentials)\s*$",RegexOptions.IgnoreCase))view.SafetyBlocked=true;
    if(current.IsPassword || Sensitive(name,automationId)) { if(current.IsPassword)view.SafetyBlocked=true; Need(view.Passwords.Count<64,"desktop_denied"); view.Passwords.Add(area); fingerprint.Append("private:").Append(area.ToString()); continue; }
    Need(name.Length<=65536 && automationId.Length<=4096,"desktop_denied");
    int[] runtime=element.GetRuntimeId(); Need(runtime!=null && runtime.Length>0 && runtime.Length<=64,"desktop_element_unavailable");
    object valuePattern,invokePattern,scrollPattern,textPattern; bool hasValue=element.TryGetCurrentPattern(ValuePattern.Pattern,out valuePattern), hasInvoke=element.TryGetCurrentPattern(InvokePattern.Pattern,out invokePattern), hasScroll=element.TryGetCurrentPattern(ScrollPattern.Pattern,out scrollPattern), hasText=element.TryGetCurrentPattern(TextPattern.Pattern,out textPattern);
    bool textual=current.ControlType==ControlType.Edit || current.ControlType==ControlType.Document;
    var nativePrivacy=textual ? NativeEditWindow(window,element) : null;
    if(nativePrivacy!=null && (nativePrivacy.Style & DesktopNativeEditPolicy.Password)!=0) { view.SafetyBlocked=true;Need(view.Passwords.Count<64,"desktop_denied");view.Passwords.Add(area);fingerprint.Append("private:").Append(area.ToString());continue; }
    LegacyText legacy=textual ? textScope.Get(element) : null;
    if(legacy!=null && (legacy.State & DesktopTextPolicy.Protected)!=0) { view.SafetyBlocked=true; Need(view.Passwords.Count<64,"desktop_denied"); view.Passwords.Add(area); fingerprint.Append("private:").Append(area.ToString());continue; }
    if(legacy!=null && !DesktopTextPolicy.CanRead(legacy.State,current.IsPassword))continue;
    bool? textReadOnly=textual && hasText ? TextReadOnly(element) : null;
    string value=null,source=null; bool readOnly=legacy==null || (legacy.State & DesktopTextPolicy.ReadOnly)!=0;
    if(hasValue) { var valueInfo=((ValuePattern)valuePattern).Current; readOnly=valueInfo.IsReadOnly; value=valueInfo.Value ?? "";source="value"; }
    else if(legacy!=null && legacy.Value!=null) { value=legacy.Value;readOnly=(legacy.State & DesktopTextPolicy.ReadOnly)!=0;source="legacy"; }
    else if(hasText && textual && (current.ControlType==ControlType.Edit || Regex.IsMatch(current.ClassName ?? "",@"(?:^|[.])(Edit|RichEdit\w*|RichTextBox|TextBox)(?:[.]|$)",RegexOptions.IgnoreCase))) {
     value=((TextPattern)textPattern).DocumentRange.GetText(65537);source="text";
     object attribute=((TextPattern)textPattern).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);if(attribute is bool)readOnly=(bool)attribute;
    }
    if(value!=null)Need(value.Length<=65536,"desktop_denied");
    if(legacy!=null && (legacy.State & DesktopTextPolicy.ReadOnly)!=0)readOnly=true;
    if(textReadOnly==true)readOnly=true;
    bool restricted=Restricted(name,automationId), enabled=current.IsEnabled && (legacy==null || (legacy.State & (DesktopTextPolicy.Unavailable|DesktopTextPolicy.Busy))==0);
    bool legacyWritable=!hasValue && value!=null && !readOnly && legacy!=null && DesktopTextPolicy.CanSetLegacy(current.ControlType.Id,legacy.Role,legacy.State,enabled,current.IsOffscreen,current.IsPassword,textReadOnly);
    bool valueWritable=hasValue && !readOnly;
    NativeEdit nativeEdit=textual && enabled && !restricted && !readOnly ? NativeEditIdentity(window,element,readOnly,legacy) : null;
    if(nativeEdit!=null) {
     nativeEdit.Value=ReadNativeEdit(window,element,nativeEdit,readOnly,legacy);
     if(value!=null && value!=nativeEdit.Value)nativeEdit=null;
     else if(value==null) { value=nativeEdit.Value;source="win32_edit"; }
    }
    var supported=element.GetSupportedPatterns().Select(pattern=>pattern.ProgrammaticName.Replace("PatternIdentifiers.Pattern","Pattern")).ToList();if(legacy!=null)supported.Add("LegacyIAccessiblePattern");
    var item=Obj("runtimeId",runtime,"pid",owner.Pid,"creationTime",owner.Start,"name",Cut(name,400),"automationId",Cut(automationId,400),"role",current.ControlType.ProgrammaticName,
     "className",Cut(current.ClassName,400),"frameworkId",Cut(current.FrameworkId,100),"enabled",enabled,"password",false,"hidden",false,
     "bounds",Obj("x",area.X,"y",area.Y,"width",area.Width,"height",area.Height),"parentIndex",work.Parent<0 ? null : (object)work.Parent,
     "patterns",Obj("invoke",enabled && hasInvoke && !restricted,"value",enabled && (valueWritable || legacyWritable) && !restricted,"nativeText",nativeEdit!=null,"scroll",enabled && hasScroll && !restricted),
     "supportedPatterns",supported.Distinct().Take(16).ToArray(),"textAccess",source,"setValueTransport",valueWritable ? "value" : legacyWritable ? "legacy" : null);
    if(textual || hasValue)item["readOnly"]=readOnly;
    if(textual) { item["textReadOnlyKnown"]=textReadOnly.HasValue;if(textReadOnly.HasValue)item["textReadOnly"]=textReadOnly.Value; }
    if(legacy!=null) { item["legacyRole"]=legacy.Role;item["legacyState"]=legacy.State;item["legacyReadOnly"]=(legacy.State & DesktopTextPolicy.ReadOnly)!=0; }
    if(hasValue)item["valueReadOnly"]=((ValuePattern)valuePattern).Current.IsReadOnly;
    if(nativeEdit!=null) { item["nativeWindowHandle"]=nativeEdit.Proof["hwnd"];item["nativeEdit"]=NativeEditProof(nativeEdit); }
    if(textual || hasValue) {
     string denial=restricted ? "restricted_control" : !enabled ? "not_enabled" : readOnly ? "read_only" : valueWritable ? null
      : legacy==null ? "legacy_pattern_unavailable" : value==null ? "full_value_unavailable"
      : DesktopTextPolicy.SetValueDenial(current.ControlType.Id,legacy.Role,legacy.State,enabled,current.IsOffscreen,current.IsPassword,textReadOnly);
     item["setValueDenial"]=denial;
    }
    if(value!=null) { item["value"]=Cut(value,1000); item["valueChars"]=value.Length; item["valueTruncated"]=value.Length>1000; item["valueSha256"]=Hash(value); }
    if(restricted)item["blockedReason"]="Permission, settings, terminal and approval controls are excluded";
    item["nameSha256"]=Hash(name); item["automationIdSha256"]=Hash(automationId);
    string hash=ElementHash(item); item["fingerprint"]=hash; fingerprint.Append(hash);
    int position=view.All.Count; view.All.Add(item); view.Elements.Add(element);
    var child=TreeWalker.ControlViewWalker.GetFirstChild(element); if(child!=null && work.Depth>=MaxDepth) { view.Complete=false; continue; }
    var siblings=new List<AutomationElement>(); while(child!=null) { if(siblings.Count>=MaxVisited) { view.Complete=false; break; } siblings.Add(child); child=TreeWalker.ControlViewWalker.GetNextSibling(child); }
    for(int i=siblings.Count-1;i>=0;i--)stack.Push(new Item(siblings[i],work.Depth+1,position));
   }
   WindowIdentity(window.Hwnd,new HashSet<string>(new string[] {window.Process.Path},StringComparer.OrdinalIgnoreCase),WindowJson(window));
   var visible=view.All.Take(MaxNodes).ToList();
   view.SafetyBlocked |= approveButton && rejectButton;
   if(!view.Complete || view.SafetyBlocked) foreach(var item in visible) { item["patterns"]=Obj("invoke",false,"value",false,"nativeText",false,"scroll",false); item["blockedReason"]="Incomplete privacy/context scan or an approval/security surface is present"; item["setValueDenial"]="context_policy_blocked"; }
   foreach(var item in visible) { object parent=item["parentIndex"]; if(parent!=null && Convert.ToInt32(parent)>=MaxNodes)item["parentIndex"]=null; }
   view.Result=Obj("window",WindowJson(window),"bounds",Bounds(window.Bounds),"foreground",GetForegroundWindow()==window.Hwnd,"fingerprint",Hash(Json.Serialize(WindowJson(window))+Json.Serialize(Bounds(window.Bounds))+fingerprint.ToString()+view.Complete.ToString()+view.SafetyBlocked.ToString()),
    "elements",visible,"truncated",view.All.Count>MaxNodes || !view.Complete,"contextComplete",view.Complete,"warnings",new string[] {"Only visible controls inside the selected window are observed; password/sensitive subtrees are excluded.","Semantic background operations do not change focus or inject global input."});
   if(capture) { Need(view.Complete,"desktop_capture_unavailable"); view.Result["image"]=Capture(window,view.Passwords); }
   return view;
   }
  }
  static Dictionary<string,object> Capture(Window window,List<Rectangle> passwords) {
   int width=window.Bounds.Right-window.Bounds.Left,height=window.Bounds.Bottom-window.Bounds.Top;
   Need(width>0 && height>0 && (long)width*height<=MaxPixels,"desktop_capture_unavailable");
   using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
    using(var graphics=Graphics.FromImage(bitmap)) { graphics.Clear(Color.Magenta); IntPtr dc=graphics.GetHdc(); bool rendered;
     try { rendered=PrintWindow(window.Hwnd,dc,2); } finally { graphics.ReleaseHdc(dc); }
     Need(rendered,"desktop_capture_unavailable");
     RECT client; Need(GetClientRect(window.Hwnd,out client),"desktop_capture_unavailable"); POINT origin=new POINT(); Need(ClientToScreen(window.Hwnd,ref origin),"desktop_capture_unavailable");
     var area=new Rectangle(origin.X-window.Bounds.Left,origin.Y-window.Bounds.Top,client.Right-client.Left,client.Bottom-client.Top); area.Intersect(new Rectangle(0,0,width,height));
     Need(area.Width>0 && area.Height>0,"desktop_capture_unavailable"); int first=bitmap.GetPixel(area.Left,area.Top).ToArgb(),different=0;
     int step=Math.Max(1,(int)Math.Sqrt((long)area.Width*area.Height/16384.0));
     for(int y=area.Top;y<area.Bottom && different<2;y+=step) for(int x=area.Left;x<area.Right && different<2;x+=step) if(bitmap.GetPixel(x,y).ToArgb()!=first)different++;
     Need(different>=2,"desktop_capture_unavailable");
     using(var brush=new SolidBrush(Color.Black))foreach(var region in passwords)graphics.FillRectangle(brush,region);
    }
    WindowIdentity(window.Hwnd,new HashSet<string>(new string[] {window.Process.Path},StringComparer.OrdinalIgnoreCase),WindowJson(window));
    using(var stream=new MemoryStream()) { bitmap.Save(stream,ImageFormat.Png); Need(stream.Length>0 && stream.Length<=MaxPng,"desktop_capture_unavailable"); byte[] bytes=stream.ToArray();
     string digest; using(var hash=SHA256.Create())digest=BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
     return Obj("method","PrintWindow","mimeType","image/png","dataBase64",Convert.ToBase64String(bytes),"width",width,"height",height,"sha256",digest,"passwordRegionsMasked",passwords.Count);
    }
   }
  }
  static bool SameRuntime(object raw,int[] runtime) { var values=raw as int[]; if(values!=null)return values.SequenceEqual(runtime); var array=raw as object[]; return array!=null && array.Length==runtime.Length && array.Select(value=>Convert.ToInt32(value,CultureInfo.InvariantCulture)).SequenceEqual(runtime); }
  static ScrollAmount Amount(string value) { switch(value ?? "none") { case "none":return ScrollAmount.NoAmount; case "smallIncrement":return ScrollAmount.SmallIncrement; case "smallDecrement":return ScrollAmount.SmallDecrement; case "largeIncrement":return ScrollAmount.LargeIncrement; case "largeDecrement":return ScrollAmount.LargeDecrement; default:throw new Denial("desktop_denied"); } }
  static bool Unexpired(Dictionary<string,object> request) { object value; return request.TryGetValue("expiresAt",out value) && Convert.ToInt64(value,CultureInfo.InvariantCulture)>=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; }
  static void Diagnostics(Dictionary<string,object> result,string phase,bool attempted,string planned,string transport,int? hresult,string source,uint? win32Error) {
   result["nativePhase"]=phase;result["dispatchAttempted"]=attempted;
   if(planned!=null)result["plannedTextTransport"]=planned;
   if(transport!=null)result["textTransport"]=transport;
   if(hresult.HasValue) { result["nativeHresult"]=hresult.Value;result["nativeHresultSource"]=source; }
   if(win32Error.HasValue)result["nativeWin32Error"]=win32Error.Value;
  }
  public static string Run(string input) {
   bool attempted=false; IntPtr priorDpi=IntPtr.Zero;string phase="initialize",plannedTransport=null,textTransport=null,hresultSource=null;int? nativeHresult=null;uint? nativeWin32Error=null;
   try {
    phase="request_validation";
    Need(Thread.CurrentThread.GetApartmentState()==ApartmentState.MTA && input.Length<=65536,"desktop_denied");
    priorDpi=SetThreadDpiAwarenessContext(new IntPtr(-4)); Need(priorDpi!=IntPtr.Zero,"desktop_unsupported");
    var request=Json.DeserializeObject(input) as Dictionary<string,object>; Need(request!=null,"desktop_denied");
    string operation=Str(request,"operation"); var allowed=Allowlist(request);
    if(operation=="health")return Json.Serialize(Obj("ok",true,"engine","windows-uia","apartment","MTA"));
    if(operation=="list") {
     var windows=new List<Dictionary<string,object>>(); EnumWindows(delegate(IntPtr hwnd,IntPtr extra) {
      if(windows.Count>=32)return false;
      try { uint pid; GetWindowThreadProcessId(hwnd,out pid); var proc=ProcessIdentity((int)pid); if(!allowed.Contains(proc.Path))return true;
       var window=WindowIdentity(hwnd,allowed,null); var item=WindowJson(window); item["foreground"]=GetForegroundWindow()==hwnd; windows.Add(item);
      } catch { } return true;
     },IntPtr.Zero); return Json.Serialize(Obj("ok",true,"windows",windows));
    }
    phase="window_validation";var expected=Map(request,"target"); var bound=WindowIdentity(Hwnd(expected),allowed,expected);
    phase="observation";
    if(operation=="observe")return Json.Serialize(Obj("ok",true,"observation",Observe(bound,Bool(request,"includeImage")).Result));
    Need(operation=="act","desktop_denied"); Need(Unexpired(request),"desktop_stale"); var before=Observe(bound,false); Need(before.Complete && !before.SafetyBlocked,"desktop_denied"); Need(Str(request,"expectedFingerprint")==Str(before.Result,"fingerprint"),"desktop_stale");
    phase="element_validation";
    var wanted=Map(request,"element"); var action=Map(request,"action"); Need(wanted!=null && action!=null,"desktop_denied"); int index=-1;
    for(int i=0;i<Math.Min(MaxNodes,before.All.Count);i++) if(SameRuntime(wanted["runtimeId"],(int[])before.All[i]["runtimeId"])) { index=i;break; }
    Need(index>=0 && Str(wanted,"fingerprint")==Str(before.All[index],"fingerprint"),"desktop_stale"); var element=before.Elements[index]; var current=element.Current;
    Need(current.IsEnabled && !current.IsOffscreen && !current.IsPassword,"desktop_denied");
    WindowIdentity(bound.Hwnd,allowed,expected); Need(Unexpired(request) && element.GetRuntimeId().SequenceEqual((int[])before.All[index]["runtimeId"]),"desktop_stale");
    string kind=Str(action,"operation"); var patterns=(Dictionary<string,object>)before.All[index]["patterns"]; string requested=Str(action,"value"); object pattern=null;
    if(kind=="setValue") {
     phase="set_value_preflight";plannedTransport=Str(before.All[index],"setValueTransport");
     var unsupported=new Denial("desktop_unsupported") { Supported=(string[])before.All[index]["supportedPatterns"],ReadOnly=before.All[index].ContainsKey("readOnly") ? (bool?)before.All[index]["readOnly"] : null };
     if(!Bool(patterns,"value") || requested==null || requested.Length>4000 || requested.IndexOf('\0')>=0)throw unsupported;
     using(var textScope=new NativeTextScope(bound.Hwnd)) {
      LegacyText legacy=(current.ControlType==ControlType.Edit || current.ControlType==ControlType.Document) ? textScope.Get(element) : null;
      if(legacy!=null) { legacy.RefreshState();if(!legacy.Matches(element) || !legacy.Runtime.SequenceEqual((int[])before.All[index]["runtimeId"]))throw new Denial("desktop_stale");
       if(!DesktopTextPolicy.CanRead(legacy.State,current.IsPassword) || (legacy.State & (DesktopTextPolicy.ReadOnly|DesktopTextPolicy.Unavailable|DesktopTextPolicy.Busy))!=0)throw unsupported; }
      if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
       phase="set_value_revalidation";
       var writable=(ValuePattern)pattern; if(writable.Current.IsReadOnly || TextReadOnly(element)==true)throw unsupported;
       Need(Hash(writable.Current.Value ?? "")==Str(before.All[index],"valueSha256"),"desktop_stale");
       Need(Str(Observe(WindowIdentity(bound.Hwnd,allowed,expected),false).Result,"fingerprint")==Str(request,"expectedFingerprint"),"desktop_stale");
       WindowIdentity(bound.Hwnd,allowed,expected);Need(Unexpired(request) && element.GetRuntimeId().SequenceEqual((int[])before.All[index]["runtimeId"]),"desktop_stale");
       if(writable.Current.IsReadOnly || TextReadOnly(element)==true)throw unsupported;
       phase="set_value_dispatch";attempted=true;textTransport="value";writable.SetValue(requested);
      } else {
       phase="set_value_revalidation";
       bool? writableText=TextReadOnly(element);
       if(legacy==null || !DesktopTextPolicy.CanSetLegacy(current.ControlType.Id,legacy.Role,legacy.State,current.IsEnabled,current.IsOffscreen,current.IsPassword,writableText))throw unsupported;
       string full;if(legacy.Pattern.get_CurrentValue(out full)<0) { object readable;Need(element.TryGetCurrentPattern(TextPattern.Pattern,out readable),"desktop_unsupported");full=((TextPattern)readable).DocumentRange.GetText(65537); }
       Need(full!=null && full.Length<=65536 && Hash(full)==Str(before.All[index],"valueSha256"),"desktop_stale");
       Need(Str(Observe(WindowIdentity(bound.Hwnd,allowed,expected),false).Result,"fingerprint")==Str(request,"expectedFingerprint"),"desktop_stale");
       WindowIdentity(bound.Hwnd,allowed,expected);legacy.RefreshState();
       Need(Unexpired(request) && legacy.Matches(element),"desktop_stale");
       writableText=TextReadOnly(element);
       if(!DesktopTextPolicy.CanSetLegacy(element.Current.ControlType.Id,legacy.Role,legacy.State,element.Current.IsEnabled,element.Current.IsOffscreen,element.Current.IsPassword,writableText))throw unsupported;
       phase="set_value_dispatch";attempted=true;textTransport="legacy";
       nativeHresult=legacy.Pattern.SetValue(requested);hresultSource="legacy_set_value";
       Need(nativeHresult.Value>=0,"desktop_native_failed");
      }
     }
    }
    else if(kind=="setNativeText") {
     phase="native_text_preflight";plannedTransport="win32_edit";
     Need(Bool(patterns,"nativeText") && requested!=null && requested.Length<=4000 && requested.IndexOf('\0')<0,"desktop_unsupported");
     var proof=Map(before.All[index],"nativeEdit");Need(proof!=null,"desktop_unsupported");
     using(var textScope=new NativeTextScope(bound.Hwnd)) {
      var legacy=textScope.Get(element);bool readOnly=Bool(before.All[index],"readOnly");
      var edit=NativeEditIdentity(bound,element,readOnly,legacy);Need(NativeEditMatches(edit,proof),"desktop_stale");
      phase="native_text_revalidation";
      Need(Hash(ReadNativeEdit(bound,element,edit,readOnly,legacy))==Str(proof,"valueSha256"),"desktop_stale");
      Need(Str(Observe(WindowIdentity(bound.Hwnd,allowed,expected),false).Result,"fingerprint")==Str(request,"expectedFingerprint"),"desktop_stale");
      edit=NativeEditIdentity(WindowIdentity(bound.Hwnd,allowed,expected),element,readOnly,legacy);Need(NativeEditMatches(edit,proof),"desktop_stale");
      Need(Unexpired(request) && element.GetRuntimeId().SequenceEqual((int[])before.All[index]["runtimeId"]) && Hash(ReadNativeEdit(bound,element,edit,readOnly,legacy))==Str(proof,"valueSha256"),"desktop_stale");
      edit=NativeEditIdentity(WindowIdentity(bound.Hwnd,allowed,expected),element,readOnly,legacy);Need(Unexpired(request) && NativeEditMatches(edit,proof),"desktop_stale");
      UIntPtr result;phase="native_text_dispatch";attempted=true;textTransport="win32_edit";ClearLastError(0);
      if(NativeTextWrite(edit.Hwnd,0x000c,UIntPtr.Zero,requested,0x22,2000,out result)==IntPtr.Zero)throw new NativeMessageFailure(unchecked((uint)Marshal.GetLastWin32Error()));
      Need(result.ToUInt64()!=0,"desktop_native_failed");
     }
    }
    else if(kind=="invoke") { phase="invoke_preflight";Need(Bool(patterns,"invoke") && element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern),"desktop_unsupported");phase="invoke_dispatch";attempted=true; ((InvokePattern)pattern).Invoke(); }
    else if(kind=="scroll") { phase="scroll_preflight";Need(Bool(patterns,"scroll") && element.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern),"desktop_unsupported"); var scroll=(ScrollPattern)pattern; ScrollAmount horizontal=Amount(Str(action,"horizontal")),vertical=Amount(Str(action,"vertical")); Need(horizontal!=ScrollAmount.NoAmount || vertical!=ScrollAmount.NoAmount,"desktop_denied"); Need((horizontal==ScrollAmount.NoAmount || scroll.Current.HorizontallyScrollable) && (vertical==ScrollAmount.NoAmount || scroll.Current.VerticallyScrollable),"desktop_unsupported");phase="scroll_dispatch";attempted=true;scroll.Scroll(horizontal,vertical); }
    else throw new Denial("desktop_denied");
    bool textAction=kind=="setValue" || kind=="setNativeText";
    var receipt=Obj("ok",true,"dispatched",true,"effectState",textAction ? "outcome_unknown" : "input_dispatched");
    try { phase="after_observation";var after=Observe(WindowIdentity(bound.Hwnd,allowed,expected),Bool(request,"includeImage")); receipt["after"]=after.Result;
     if(textAction && after.All.Any(item=>SameRuntime(item["runtimeId"],(int[])before.All[index]["runtimeId"]) && (kind=="setNativeText" ? Map(item,"nativeEdit")!=null && Str(Map(item,"nativeEdit"),"valueSha256")==Hash(requested) : Str(item,"valueSha256")==Hash(requested))))receipt["effectState"]="value_verified";
     phase="completed";
    } catch(Denial) { receipt["effectState"]="outcome_unknown"; }
    catch(NativeMessageFailure caught) { nativeWin32Error=caught.Error;receipt["effectState"]="outcome_unknown"; }
    catch(Exception caught) { nativeHresult=caught.HResult;hresultSource="managed_exception";receipt["effectState"]="outcome_unknown"; }
    Diagnostics(receipt,phase,attempted,plannedTransport,textTransport,nativeHresult,hresultSource,nativeWin32Error);
    return Json.Serialize(receipt);
   } catch(Denial denied) { var detail=Obj("code",denied.Code);if(denied.Supported!=null)detail["supportedPatterns"]=denied.Supported;if(denied.ReadOnly.HasValue)detail["readOnly"]=denied.ReadOnly.Value;var result=Obj("ok",false,"error",detail);Diagnostics(result,phase,attempted,plannedTransport,textTransport,nativeHresult,hresultSource,nativeWin32Error);return Json.Serialize(result); }
   catch(NativeMessageFailure caught) { var result=Obj("ok",false,"error",Obj("code","desktop_native_failed"));Diagnostics(result,phase,attempted,plannedTransport,textTransport,nativeHresult,hresultSource,caught.Error);return Json.Serialize(result); }
   catch(Exception caught) { var result=Obj("ok",false,"error",Obj("code","desktop_native_failed"));Diagnostics(result,phase,attempted,plannedTransport,textTransport,caught.HResult,"managed_exception",nativeWin32Error);return Json.Serialize(result); }
   finally { if(priorDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(priorDpi); }
  }
 }
}
