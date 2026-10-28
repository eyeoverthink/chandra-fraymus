#!/usr/bin/env python3
"""Windows-only, Job-bounded launcher for the trusted stdin document parser.

Usage: python bounded-process.py ABSOLUTE_NODE_EXE ABSOLUTE_CHILD_JS MEMORY_BYTES
The Node process is created suspended, assigned to an unnamed noninheritable Job,
and only then resumed and given uploaded input. No shell or document parsing occurs
in this wrapper. Closing the Job (including wrapper TerminateProcess cancellation)
kills the child and descendants. stdout is the trusted child's JSON bytes on success.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


MAX_INPUT = 6 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
MAX_SECONDS = 18
MIN_MEMORY = 64 * 1024 * 1024
MAX_MEMORY = 512 * 1024 * 1024


class LauncherError(Exception):
    pass


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", wintypes.LPVOID),
                ("bInheritHandle", wintypes.BOOL)]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
                ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
                ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
                ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
                ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
                ("hStdError", wintypes.HANDLE)]


class STARTUPINFOEX(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", wintypes.LPVOID)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


class BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD), ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


def kernel_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    declarations = {
        "CreateJobObjectW": ([wintypes.LPVOID, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD], wintypes.BOOL),
        "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, wintypes.LPVOID], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "IsProcessInJob": ([wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL),
        "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "CreatePipe": ([ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.DWORD], wintypes.BOOL),
        "SetHandleInformation": ([wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD], wintypes.BOOL),
        "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE),
        "InitializeProcThreadAttributeList": ([wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)], wintypes.BOOL),
        "UpdateProcThreadAttribute": ([wintypes.LPVOID, wintypes.DWORD, ctypes.c_size_t, wintypes.LPVOID, ctypes.c_size_t, wintypes.LPVOID, wintypes.LPVOID], wintypes.BOOL),
        "DeleteProcThreadAttributeList": ([wintypes.LPVOID], None),
        "CreateProcessW": ([wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID, wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOEX), ctypes.POINTER(PROCESS_INFORMATION)], wintypes.BOOL),
        "ResumeThread": ([wintypes.HANDLE], wintypes.DWORD),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "GetExitCodeProcess": ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (arguments, result) in declarations.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    return kernel


def require(value, message):
    if not value:
        raise LauncherError(message)


def reduced_environment():
    names = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG")
    environment = {name: os.environ[name] for name in names if name in os.environ}
    require(environment.get("SystemRoot") or environment.get("WINDIR"), "Windows process environment is unavailable.")
    if "SystemRoot" not in environment:
        environment["SystemRoot"] = environment["WINDIR"]
    return ctypes.create_unicode_buffer("\0".join(
        name + "=" + value for name, value in sorted(environment.items(), key=lambda item: item[0].upper())
    ) + "\0\0")


def bounded_input(deadline):
    finished = threading.Event()
    result = {"parts": [], "error": False}

    def read():
        total = 0
        try:
            while True:
                data = os.read(0, min(65536, MAX_INPUT + 1 - total))
                if not data:
                    break
                total += len(data)
                if total > MAX_INPUT:
                    result["error"] = True
                    break
                result["parts"].append(data)
        except OSError:
            result["error"] = True
        finally:
            finished.set()

    threading.Thread(target=read, daemon=True).start()
    require(finished.wait(max(0, deadline - time.monotonic())), "Document parser input timed out.")
    require(not result["error"], "Document parser input exceeds 6 MiB or could not be read.")
    return b"".join(result["parts"])


def run(node, script, memory, payload, deadline):
    import msvcrt
    kernel = kernel_api()
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
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(node), "--max-old-space-size=64", str(script)]))
            environment = reduced_environment()
            flags = 0x08000000 | 0x00000004 | 0x00000400 | 0x00080000
            require(kernel.CreateProcessW(str(node), command, None, None, True, flags,
                    ctypes.cast(environment, wintypes.LPVOID), str(script.parent), ctypes.byref(startup), ctypes.byref(process)),
                    "Trusted Node parser could not be created.")
        finally:
            kernel.DeleteProcThreadAttributeList(startup.lpAttributeList)

        require(kernel.AssignProcessToJobObject(job, process.hProcess), "Node parser could not be assigned to its Windows Job.")
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
        require(kernel.ResumeThread(process.hThread) != 0xffffffff, "Trusted Node parser could not be resumed.")
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
            require(time.monotonic() < deadline, "Document parser exceeded its 18 second time limit.")
            require(not state["overflow"], "Document parser output exceeds 16 MiB.")
            if kernel.WaitForSingleObject(process.hProcess, 20) == 0 and output_ready.is_set() and input_ready.is_set():
                break
        exit_code = wintypes.DWORD()
        require(not state["overflow"], "Document parser output exceeds 16 MiB.")
        require(kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)), "Document parser exit status is unavailable.")
        require(exit_code.value == 0 and not state["io_error"], "Document parser failed within its bounded Windows process.")
        result = b"".join(state["parts"])
        require(result.strip(), "Document parser returned no JSON result.")
    finally:
        # Terminate the Job even on normal child exit to remove any descendants.
        # Exact process handles are used; no PID/name search can affect another app.
        if job:
            kernel.TerminateJobObject(job, 1)
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
        require(stopped, "Document parser cleanup could not be confirmed.")
    return result


def emit(data):
    position = 0
    while position < len(data):
        position += os.write(1, data[position:position + 65536])


def main(arguments):
    try:
        require(os.name == "nt", "Windows Job Objects are required; document parsing is unavailable on this platform.")
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
        require(len(arguments) == 4, "Expected absolute Node executable, trusted parser script, and committed-memory byte limit.")
        node, script = Path(arguments[1]), Path(arguments[2])
        require(node.is_absolute() and script.is_absolute() and node.is_file() and script.is_file(), "Trusted parser executable and script must be existing absolute paths.")
        require(node.name.lower() == "node.exe" and script.suffix.lower() in (".js", ".cjs", ".mjs"), "Trusted parser executable or script type is invalid.")
        require(re.fullmatch(r"[0-9]{1,10}", arguments[3]), "Committed-memory byte limit is invalid.")
        memory = int(arguments[3])
        require(MIN_MEMORY <= memory <= MAX_MEMORY, "Committed-memory limit must be 64 through 512 MiB.")
        deadline = time.monotonic() + MAX_SECONDS
        payload = bounded_input(deadline)
        output = run(node.resolve(), script.resolve(), memory, payload, deadline)
        emit(output)
        return 0
    except LauncherError as error:
        message = str(error)
    except BaseException:
        message = "Bounded Windows document parser could not complete safely."
    try:
        emit(json.dumps({"ok": False, "error": message[:240]}, separators=(",", ":")).encode("utf-8"))
    except OSError:
        pass
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
