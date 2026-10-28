// Native UIA COM prefixes verified against Microsoft's pinned SDK header:
// microsoft/win32metadata 9cf94833626504b330c2f616ce71a2d3497cdc76,
// generation/WinSDK/RecompiledIdlHeaders/um/UIAutomationClient.h
// SHA256 66b00453430cc6884482352ebc0ddf6db3916e38bf5684caba79d6e86aa1f038.
// PreserveSig keeps HRESULT handling explicit. IUnknown's three slots are implicit.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace Fraymus {
 public static class DesktopNativeEditPolicy {
  public const uint Child=0x40000000,Visible=0x10000000,Disabled=0x08000000,Password=0x20,ReadOnly=0x800;
  public static bool BasicClass(string name) { return name!=null && name.Length<=200 && (String.Equals(name,"Edit",StringComparison.OrdinalIgnoreCase)
   || Regex.IsMatch(name,@"^WindowsForms10[.]EDIT[.]app[.][0-9a-f]{1,16}[.][0-9a-f]{1,16}_r[0-9]{1,3}_ad[0-9]{1,3}$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant)); }
  public static bool Eligible(int controlType,string name,uint style,bool samePid,bool child,bool sameRoot,bool enabled,bool visible,bool offscreen,bool password,bool readOnly,bool? textReadOnly,uint legacyState) {
   return (controlType==50004 || controlType==50030) && BasicClass(name) && samePid && child && sameRoot && enabled && visible && !offscreen && !password && !readOnly && textReadOnly!=true
    && (style & (Child|Visible))==(Child|Visible) && (style & (Disabled|Password|ReadOnly))==0 && (legacyState & DesktopTextPolicy.SafetyStateMask)==0;
  }
 }
 public static class DesktopTextPolicy {
  public const uint ReadOnly=0x40, Protected=0x20000000, Unavailable=0x1, Invisible=0x8000, Offscreen=0x10000, Busy=0x800;
  public const uint SafetyStateMask=ReadOnly|Protected|Unavailable|Invisible|Offscreen|Busy;
  public static bool CanRead(uint state,bool password) { return !password && (state & (Protected|Invisible|Offscreen))==0; }
  public static bool CanSetLegacy(int controlType,uint role,uint state,bool enabled,bool offscreen,bool password) {
   return CanSetLegacy(controlType,role,state,enabled,offscreen,password,null);
  }
  public static bool CanSetLegacy(int controlType,uint role,uint state,bool enabled,bool offscreen,bool password,bool? textReadOnly) {
   bool textRole=role==0x2a && (controlType==50004 || controlType==50030);
   // ROLE_SYSTEM_DOCUMENT is eligible only with a separate TextPattern boolean
   // assertion that this exact document is writable. The setter can still fail.
   bool documentRole=role==0x0f && controlType==50030 && textReadOnly.HasValue && !textReadOnly.Value;
   return (textRole || documentRole) && textReadOnly!=true && enabled && !offscreen && !password
    && (state & (ReadOnly|Protected|Unavailable|Invisible|Offscreen|Busy))==0;
  }
  public static string SetValueDenial(int controlType,uint role,uint state,bool enabled,bool offscreen,bool password) {
   return SetValueDenial(controlType,role,state,enabled,offscreen,password,null);
  }
  public static string SetValueDenial(int controlType,uint role,uint state,bool enabled,bool offscreen,bool password,bool? textReadOnly) {
   if(password || (state & Protected)!=0)return "legacy_protected";
   if((state & ReadOnly)!=0)return "legacy_read_only";
   if(!enabled || (state & Unavailable)!=0)return "legacy_unavailable";
   if(offscreen || (state & (Invisible|Offscreen))!=0)return "legacy_offscreen_or_invisible";
   if((state & Busy)!=0)return "legacy_busy";
   if(controlType!=50004 && controlType!=50030)return "not_edit_or_document";
   if(textReadOnly==true)return "text_read_only";
   if(role==0x0f && controlType==50030 && !textReadOnly.HasValue)return "writable_text_attribute_unavailable";
   if(role!=0x2a && !(role==0x0f && controlType==50030 && textReadOnly==false))return "legacy_role_not_supported";
   return null;
  }
 }
 // Slots and signatures are the SDK's exact interface prefixes. Unused methods
 // remain declarations only; the fixed driver never calls Select/DoDefaultAction.
 [ComImport,Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 internal interface NativeAutomation {
  [PreserveSig]int CompareElements(IntPtr first,IntPtr second,[MarshalAs(UnmanagedType.Bool)]out bool equal);
  [PreserveSig]int CompareRuntimeIds(IntPtr first,IntPtr second,[MarshalAs(UnmanagedType.Bool)]out bool equal);
  [PreserveSig]int GetRootElement(out NativeElement root);
  [PreserveSig]int ElementFromHandle(IntPtr hwnd,out NativeElement element);
  [PreserveSig]int ElementFromPoint(NativePoint point,out NativeElement element);
  [PreserveSig]int GetFocusedElement(out NativeElement element);
  [PreserveSig]int GetRootElementBuildCache(IntPtr cache,out NativeElement root);
  [PreserveSig]int ElementFromHandleBuildCache(IntPtr hwnd,IntPtr cache,out NativeElement element);
  [PreserveSig]int ElementFromPointBuildCache(NativePoint point,IntPtr cache,out NativeElement element);
  [PreserveSig]int GetFocusedElementBuildCache(IntPtr cache,out NativeElement element);
  [PreserveSig]int CreateTreeWalker(IntPtr condition,out NativeWalker walker);
  [PreserveSig]int get_ControlViewWalker(out NativeWalker walker);
 }
 [StructLayout(LayoutKind.Sequential)] internal struct NativePoint { public int X,Y; }
 [ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 internal interface NativeElement {
  [PreserveSig]int SetFocus();
  [PreserveSig]int GetRuntimeId([MarshalAs(UnmanagedType.SafeArray,SafeArraySubType=VarEnum.VT_I4)]out int[] runtime);
  [PreserveSig]int FindFirst(int scope,IntPtr condition,out NativeElement found);
  [PreserveSig]int FindAll(int scope,IntPtr condition,out IntPtr found);
  [PreserveSig]int FindFirstBuildCache(int scope,IntPtr condition,IntPtr cache,out NativeElement found);
  [PreserveSig]int FindAllBuildCache(int scope,IntPtr condition,IntPtr cache,out IntPtr found);
  [PreserveSig]int BuildUpdatedCache(IntPtr cache,out NativeElement found);
  [PreserveSig]int GetCurrentPropertyValue(int property,[MarshalAs(UnmanagedType.Struct)]out object value);
  [PreserveSig]int GetCurrentPropertyValueEx(int property,[MarshalAs(UnmanagedType.Bool)]bool ignoreDefault,[MarshalAs(UnmanagedType.Struct)]out object value);
  [PreserveSig]int GetCachedPropertyValue(int property,[MarshalAs(UnmanagedType.Struct)]out object value);
  [PreserveSig]int GetCachedPropertyValueEx(int property,[MarshalAs(UnmanagedType.Bool)]bool ignoreDefault,[MarshalAs(UnmanagedType.Struct)]out object value);
  [PreserveSig]int GetCurrentPatternAs(int pattern,ref Guid iid,out IntPtr value);
  [PreserveSig]int GetCachedPatternAs(int pattern,ref Guid iid,out IntPtr value);
  [PreserveSig]int GetCurrentPattern(int pattern,[MarshalAs(UnmanagedType.IUnknown)]out object value);
 }
 [ComImport,Guid("4042c624-389c-4afc-a630-9df854a541fc"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 internal interface NativeWalker {
  [PreserveSig]int GetParentElement(NativeElement element,out NativeElement parent);
  [PreserveSig]int GetFirstChildElement(NativeElement element,out NativeElement child);
  [PreserveSig]int GetLastChildElement(NativeElement element,out NativeElement child);
  [PreserveSig]int GetNextSiblingElement(NativeElement element,out NativeElement sibling);
 }
 [ComImport,Guid("828055ad-355b-4435-86d5-3b51c14a9b1b"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 internal interface NativeLegacyPattern {
  [PreserveSig]int Select(int flags);
  [PreserveSig]int DoDefaultAction();
  [PreserveSig]int SetValue([MarshalAs(UnmanagedType.LPWStr)]string value);
  [PreserveSig]int get_CurrentChildId(out int child);
  [PreserveSig]int get_CurrentName([MarshalAs(UnmanagedType.BStr)]out string value);
  [PreserveSig]int get_CurrentValue([MarshalAs(UnmanagedType.BStr)]out string value);
  [PreserveSig]int get_CurrentDescription([MarshalAs(UnmanagedType.BStr)]out string value);
  [PreserveSig]int get_CurrentRole(out uint value);
  [PreserveSig]int get_CurrentState(out uint value);
 }
 [ComImport,Guid("ff48dba4-60ef-4201-aa87-54103eef594e")]
 internal class NativeAutomationClass { }
 internal sealed class LegacyText {
  internal NativeLegacyPattern Pattern; internal NativeElement Element; internal int[] Runtime; internal uint State,Role; internal string Value;
  internal bool Matches(AutomationElement managed) {
   int[] current; return Element.GetRuntimeId(out current)>=0 && current!=null && current.SequenceEqual(Runtime) && managed.GetRuntimeId().SequenceEqual(Runtime);
  }
  internal void RefreshState() {
   if(Pattern.get_CurrentState(out State)<0 || Pattern.get_CurrentRole(out Role)<0)throw new InvalidOperationException("Legacy accessibility state unavailable");
  }
 }
 internal sealed class NativeTextScope : IDisposable {
  readonly IntPtr Root; NativeAutomation Automation; NativeWalker Walker; Dictionary<string,NativeElement> Elements;
  readonly List<object> References=new List<object>();
  internal NativeTextScope(IntPtr root) { Root=root; }
  T Keep<T>(T value) where T:class { if(value!=null)References.Add(value); return value; }
  void Start() { if(Automation==null)Automation=Keep((NativeAutomation)new NativeAutomationClass()); }
  static string Key(int[] runtime) { return runtime==null ? null : String.Join(",",runtime.Select(value=>value.ToString(CultureInfo.InvariantCulture)).ToArray()); }
  bool Runtime(NativeElement element,out int[] runtime) { runtime=null; return element!=null && element.GetRuntimeId(out runtime)>=0 && runtime!=null && runtime.Length>0 && runtime.Length<=64; }
  void Index() {
   if(Elements!=null)return; Elements=new Dictionary<string,NativeElement>(); Start(); NativeElement root;
   if(Automation.ElementFromHandle(Root,out root)<0 || root==null || Automation.get_ControlViewWalker(out Walker)<0 || Walker==null)throw new InvalidOperationException("Native scoped UIA tree unavailable");
   Keep(root);Keep(Walker); var stack=new Stack<Tuple<NativeElement,int>>();stack.Push(Tuple.Create(root,0)); int visited=0;
   while(stack.Count>0) {
    if(++visited>2048)break; var item=stack.Pop(); int[] runtime; if(Runtime(item.Item1,out runtime))Elements[Key(runtime)]=item.Item1;
    if(item.Item2>=24)continue; NativeElement child; if(Walker.GetFirstChildElement(item.Item1,out child)<0)continue;
    var siblings=new List<NativeElement>(); while(child!=null && siblings.Count<2048) { siblings.Add(Keep(child)); NativeElement next; if(Walker.GetNextSiblingElement(child,out next)<0)break;child=next; }
    for(int index=siblings.Count-1;index>=0;index--)stack.Push(Tuple.Create(siblings[index],item.Item2+1));
   }
  }
  internal LegacyText Get(AutomationElement managed) {
   Start(); int[] expected=managed.GetRuntimeId(),actual; NativeElement element=null; int hwnd=managed.Current.NativeWindowHandle;
   if(hwnd!=0) { NativeElement direct; if(Automation.ElementFromHandle(new IntPtr(hwnd),out direct)>=0 && direct!=null) { Keep(direct); if(Runtime(direct,out actual) && actual.SequenceEqual(expected))element=direct; } }
   if(element==null) { Index(); Elements.TryGetValue(Key(expected),out element); }
   if(element==null || !Runtime(element,out actual) || !actual.SequenceEqual(expected))return null;
   object raw; if(element.GetCurrentPattern(10018,out raw)<0 || raw==null)return null; Keep(raw);
   var pattern=raw as NativeLegacyPattern; if(pattern==null)return null;
   var result=new LegacyText { Pattern=pattern,Element=element,Runtime=expected };result.RefreshState();
   // Read protected/invisible state before touching the legacy value property.
   if(DesktopTextPolicy.CanRead(result.State,managed.Current.IsPassword)) { string value; if(pattern.get_CurrentValue(out value)>=0) { result.Value=value ?? ""; if(result.Value.Length>65536)throw new InvalidOperationException("Legacy value bound exceeded"); } }
   return result;
  }
  public void Dispose() { for(int index=References.Count-1;index>=0;index--)try { if(Marshal.IsComObject(References[index]))Marshal.ReleaseComObject(References[index]); } catch { } References.Clear(); }
 }
}
