#!/usr/bin/env python3
"""Fixed Windows UIA controller launcher, derived from the reviewed document Job guard.

Private stdin framing: one bounded JSON line, then CANCEL or EOF requests cleanup.
Creates the fixed PowerShell/MTA worker suspended, verifies memory/job membership,
then resumes and forwards data. Only after job active-process count reaches zero
is a result returned. No application is assigned to this Job, only our controller.
"""
from __future__ import annotations
import base64
import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('desktop_reviewed_job_types',HERE.parent/'documents'/'bounded-process.py')
guard=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
kernel_api=guard.kernel_api
require=guard.require
reduced_environment=guard.reduced_environment
LauncherError=guard.LauncherError
EXTENDED_LIMIT_INFORMATION=guard.EXTENDED_LIMIT_INFORMATION
PROCESS_INFORMATION=guard.PROCESS_INFORMATION
SECURITY_ATTRIBUTES=guard.SECURITY_ATTRIBUTES
STARTUPINFOEX=guard.STARTUPINFOEX
MAX_INPUT=65536
MAX_OUTPUT=8*1024*1024
LAST_CLEANUP={"confirmed":True,"remainingProcesses":0,"backend":"windows-job","processStarted":False}

class JOB_ACCOUNTING(ctypes.Structure):
    _fields_=[('TotalUserTime',ctypes.c_longlong),('TotalKernelTime',ctypes.c_longlong),
              ('PeriodUserTime',ctypes.c_longlong),('PeriodKernelTime',ctypes.c_longlong),
              ('PageFaults',wintypes.DWORD),('TotalProcesses',wintypes.DWORD),
              ('ActiveProcesses',wintypes.DWORD),('TerminatedProcesses',wintypes.DWORD)]

BOOTSTRAP_TEXT=r"""
$ErrorActionPreference='Stop'
$OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=$OutputEncoding
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$refs=@('System.dll','System.Core.dll')
foreach($name in @('UIAutomationClient','UIAutomationTypes','WindowsBase','System.Drawing','System.Web.Extensions')) {
 $assembly=[Reflection.Assembly]::LoadWithPartialName($name)
 if($null -eq $assembly){throw 'Required Windows assembly unavailable'}
 $refs+=$assembly.Location
}
Add-Type -Path @([IO.Path]::Combine([Environment]::CurrentDirectory,'windows-uia.cs'),[IO.Path]::Combine([Environment]::CurrentDirectory,'windows-uia-legacy.cs')) -ReferencedAssemblies $refs
[Console]::Out.Write([Fraymus.Desktop]::Run([Console]::In.ReadToEnd()))
"""
BOOTSTRAP=base64.b64encode(BOOTSTRAP_TEXT.encode('utf-16le')).decode('ascii')

def run(node, script, memory, payload, deadline, cancelled):
    global LAST_CLEANUP
    import msvcrt
    kernel = kernel_api()
    LAST_CLEANUP = {"confirmed": False, "remainingProcesses": None, "backend": "windows-job"}
    job = None
    process = PROCESS_INFORMATION()
    handles = []
    parent_input = parent_output = None
    reader = writer = None
    result = None
    try:
        # No SECURITY_ATTRIBUTES means the Job handle is not inheritable. An unnamed
        # Job cannot be kept alive by a child or opened by name after wrapper death.
        job = kernel.CreateJobObjectW(None, None)
        require(job, "Windows Job Object could not be created.")
        limits = EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x100 | 0x200
        limits.ProcessMemoryLimit = memory
        limits.JobMemoryLimit = memory
        require(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)),
                "Windows committed-memory limits could not be established.")
        verified = EXTENDED_LIMIT_INFORMATION()
        require(kernel.QueryInformationJobObject(job, 9, ctypes.byref(verified), ctypes.sizeof(verified), None)
                and verified.ProcessMemoryLimit == memory and verified.JobMemoryLimit == memory
                and verified.BasicLimitInformation.LimitFlags & 0x2300 == 0x2300,
                "Windows Job Object limits could not be verified.")

        attributes = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), None, True)
        child_input, input_write = wintypes.HANDLE(), wintypes.HANDLE()
        output_read, child_output = wintypes.HANDLE(), wintypes.HANDLE()
        require(kernel.CreatePipe(ctypes.byref(child_input), ctypes.byref(input_write), ctypes.byref(attributes), 65536), "Parser input pipe could not be created.")
        handles.extend([child_input.value, input_write.value])
        require(kernel.CreatePipe(ctypes.byref(output_read), ctypes.byref(child_output), ctypes.byref(attributes), 65536), "Parser output pipe could not be created.")
        handles.extend([output_read.value, child_output.value])
        require(kernel.SetHandleInformation(input_write, 1, 0) and kernel.SetHandleInformation(output_read, 1, 0), "Parser pipe inheritance could not be restricted.")
        discard = kernel.CreateFileW("NUL", 0x40000000, 3, ctypes.byref(attributes), 3, 0x80, None)
        require(discard not in (None, ctypes.c_void_p(-1).value), "Parser error stream could not be restricted.")
        handles.append(discard)

        needed = ctypes.c_size_t()
        kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(needed))
        require(needed.value, "Windows inherited-handle allowlist is unavailable.")
        attribute_buffer = ctypes.create_string_buffer(needed.value)
        startup = STARTUPINFOEX()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.StartupInfo.dwFlags = 0x100  # STARTF_USESTDHANDLES
        startup.StartupInfo.hStdInput = child_input
        startup.StartupInfo.hStdOutput = child_output
        startup.StartupInfo.hStdError = discard
        startup.lpAttributeList = ctypes.cast(attribute_buffer, wintypes.LPVOID)
        require(kernel.InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ctypes.byref(needed)), "Windows inherited-handle allowlist could not be initialized.")
        try:
            allowed = (wintypes.HANDLE * 3)(child_input.value, child_output.value, discard)
            require(kernel.UpdateProcThreadAttribute(startup.lpAttributeList, 0, 0x20002,
                    ctypes.cast(allowed, wintypes.LPVOID), ctypes.sizeof(allowed), None, None),
                    "Windows inherited handles could not be restricted.")
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(node), "-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-EncodedCommand", BOOTSTRAP]))
            environment = reduced_environment()
            require(not cancelled.is_set(), "desktop_cancelled")
            flags = 0x08000000 | 0x00000004 | 0x00000400 | 0x00080000
            require(kernel.CreateProcessW(str(node), command, None, None, True, flags,
                    ctypes.cast(environment, wintypes.LPVOID), str(script.parent), ctypes.byref(startup), ctypes.byref(process)),
                    "Trusted UIA controller could not be created.")
        finally:
            kernel.DeleteProcThreadAttributeList(startup.lpAttributeList)

        require(kernel.AssignProcessToJobObject(job, process.hProcess), "UIA controller could not be assigned to its Windows Job.")
        member = wintypes.BOOL()
        require(kernel.IsProcessInJob(process.hProcess, job, ctypes.byref(member)) and member.value,
                "Windows Job membership could not be verified.")
        for handle in (child_input.value, child_output.value, discard):
            kernel.CloseHandle(handle); handles.remove(handle)
        # Transfer parent-pipe ownership to raw CRT descriptors used by daemon threads.
        parent_input = msvcrt.open_osfhandle(input_write.value, os.O_WRONLY | os.O_BINARY)
        handles.remove(input_write.value)
        parent_output = msvcrt.open_osfhandle(output_read.value, os.O_RDONLY | os.O_BINARY)
        handles.remove(output_read.value)
        require(not cancelled.is_set(), "desktop_cancelled")
        require(kernel.ResumeThread(process.hThread) != 0xffffffff, "Trusted UIA controller could not be resumed.")
        kernel.CloseHandle(process.hThread); process.hThread = None

        output_ready, input_ready = threading.Event(), threading.Event()
        state = {"parts": [], "overflow": False, "io_error": False}

        def read_output(descriptor):
            total = 0
            try:
                while True:
                    data = os.read(descriptor, min(65536, MAX_OUTPUT + 1 - total))
                    if not data:
                        break
                    total += len(data)
                    if total > MAX_OUTPUT:
                        state["overflow"] = True
                        break
                    state["parts"].append(data)
            except OSError:
                state["io_error"] = True
            finally:
                os.close(descriptor); output_ready.set()

        def write_input(descriptor):
            try:
                if cancelled.is_set():
                    state["io_error"] = True
                    return
                position = 0
                while position < len(payload):
                    count = os.write(descriptor, payload[position:position + 65536])
                    if count <= 0:
                        raise OSError("closed parser input")
                    position += count
            except OSError:
                state["io_error"] = True
            finally:
                os.close(descriptor); input_ready.set()

        reader = threading.Thread(target=read_output, args=(parent_output,), daemon=True)
        writer = threading.Thread(target=write_input, args=(parent_input,), daemon=True)
        reader.start(); parent_output = None
        writer.start(); parent_input = None
        while True:
            require(not cancelled.is_set(), "desktop_cancelled")
            require(time.monotonic() < deadline, "desktop_timeout")
            require(not state["overflow"], "Desktop controller output exceeds 8 MiB.")
            if kernel.WaitForSingleObject(process.hProcess, 20) == 0 and output_ready.is_set() and input_ready.is_set():
                break
        exit_code = wintypes.DWORD()
        require(not state["overflow"], "Desktop controller output exceeds 8 MiB.")
        require(kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)), "Desktop controller exit status is unavailable.")
        require(exit_code.value == 0 and not state["io_error"], "Desktop controller failed within its bounded Windows process.")
        result = b"".join(state["parts"])
        require(result.strip(), "Desktop controller returned no JSON result.")
    finally:
        # Terminate the Job even on normal child exit to remove any descendants.
        # Exact process handles are used; no PID/name search can affect another app.
        job_stopped = not job
        if job:
            terminated = bool(kernel.TerminateJobObject(job, 1))
            cleanup_deadline = time.monotonic() + 2
            while terminated and time.monotonic() < cleanup_deadline:
                accounting = JOB_ACCOUNTING()
                if kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None) and accounting.ActiveProcesses == 0:
                    job_stopped = True
                    break
                time.sleep(0.02)
        if process.hProcess and kernel.WaitForSingleObject(process.hProcess, 0) != 0:
            kernel.TerminateProcess(process.hProcess, 1)
        if job:
            kernel.CloseHandle(job); job = None
        stopped = True
        if process.hProcess:
            stopped = kernel.WaitForSingleObject(process.hProcess, 2000) == 0
            kernel.CloseHandle(process.hProcess); process.hProcess = None
        if process.hThread:
            kernel.CloseHandle(process.hThread)
        for handle in handles:
            kernel.CloseHandle(handle)
        for descriptor in (parent_input, parent_output):
            if descriptor is not None:
                os.close(descriptor)
        for thread in (reader, writer):
            if thread and thread.ident is not None:
                thread.join(timeout=0.5)
        LAST_CLEANUP = {"confirmed": bool(stopped and job_stopped), "remainingProcesses": 0 if stopped and job_stopped else None, "backend": "windows-job", "jobTerminated": bool(job_stopped), "controllerExited": bool(stopped)}
        require(stopped and job_stopped, "desktop_cleanup_uncertain")
    return result


def emit(value):
    data=json.dumps(value,ensure_ascii=True,separators=(',',':')).encode('ascii')
    position=0
    while position<len(data):
        position+=os.write(1,data[position:position+65536])

def main():
    cancelled=threading.Event()
    try:
        require(os.name=='nt','desktop_unavailable')
        import msvcrt
        msvcrt.setmode(0,os.O_BINARY)
        msvcrt.setmode(1,os.O_BINARY)
        ready=threading.Event()
        state={}
        def input_line():
            try:
                data=bytearray()
                while len(data)<=MAX_INPUT:
                    chunk=os.read(0,min(4096,MAX_INPUT+1-len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if b'\n' in data:
                        first,extra=bytes(data).split(b'\n',1)
                        state['payload']=first+b'\n'
                        state['extra']=extra
                        return
                state['payload']=bytes(data)
            except OSError:
                state['payload']=b''
            finally:
                ready.set()
        threading.Thread(target=input_line,daemon=True).start()
        require(ready.wait(5),'desktop_timeout')
        payload=state.get('payload',b'')
        require(payload.endswith(b'\n') and 1<len(payload)<=MAX_INPUT,'desktop_protocol')
        request=json.loads(payload)
        require(isinstance(request,dict) and request.get('operation') in ('health','list','observe','act'),'desktop_protocol')
        def watch_cancel():
            # No further action frames exist: EOF or any second line cancels.
            # Raw fd reads avoid a daemon BufferedReader lock at interpreter exit.
            try:
                if not state.get('extra'):
                    os.read(0,1)
            finally:
                cancelled.set()
        threading.Thread(target=watch_cancel,daemon=True).start()
        system=Path(os.environ.get('SystemRoot',os.environ.get('WINDIR','')))
        executable=system/'System32'/'WindowsPowerShell'/'v1.0'/'powershell.exe'
        script=HERE/'windows-uia.cs'
        require(system.is_absolute() and executable.is_file() and script.is_file(),'desktop_unavailable')
        result=run(executable,script,512*1024*1024,payload,time.monotonic()+20,cancelled)
        data=json.loads(result.decode('utf-8-sig'))
        require(isinstance(data,dict),'desktop_protocol')
        emit({'ok':True,'data':data,'cleanup':LAST_CLEANUP})
        return 0
    except BaseException as error:
        code=str(error) if isinstance(error,LauncherError) and str(error) in ('desktop_cancelled','desktop_timeout','desktop_protocol','desktop_unavailable','desktop_cleanup_uncertain') else 'desktop_native_failed'
        try:
            emit({'ok':False,'error':{'code':code},'cleanup':LAST_CLEANUP})
        except OSError:
            pass
        return 1

if __name__=='__main__':
    raise SystemExit(main())
