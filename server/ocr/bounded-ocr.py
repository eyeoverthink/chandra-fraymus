#!/usr/bin/env python3
"""Fixed Windows OCR worker with acknowledged Job cleanup and control cancellation.

stdin: one JSON request line, then only {"cancel":true} as a control line.
No CLI arguments or arbitrary process/script/image paths are accepted.
The original document helper supplies inert ctypes definitions only, never run().
"""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT=Path(__file__).resolve().parent
SCRIPT=ROOT/'windows-ocr.ps1'
DEFINITIONS=ROOT.parent/'documents/bounded-process.py'
POWERSHELL=Path(r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
MEMORY=512*1024*1024
MAX_INPUT=6*1024*1024
MAX_OUTPUT=256*1024

class BoundError(Exception):
    def __init__(self,code):super().__init__(code);self.code=code
def need(value,code):
    if not value:raise BoundError(code)
def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
    result={'ok':False,'code':'ocr_unavailable'}
    resource={'memoryBytes':MEMORY,'activeProcessLimit':1,'killOnJobClose':True,'jobVerifiedBeforeResume':False,
              'notCreated':True,'childExited':True,'activeProcesses':0,'stdioDrained':True,'jobClosed':True,'cleanupConfirmed':True}
    result['resource']=resource
    started=time.monotonic();deadline=started+12
    cancelled,first,reader_done=threading.Event(),threading.Event(),threading.Event()
    input_state={'body':None,'error':False}
    def input_reader():
        pending=bytearray()
        try:
            while True:
                chunk=os.read(0,65536)
                if not chunk:cancelled.set();break
                pending.extend(chunk)
                limit=MAX_INPUT if input_state['body'] is None else 256
                if len(pending)>limit:input_state['error']=True;cancelled.set();break
                while b'\n' in pending:
                    line,_,tail=pending.partition(b'\n');pending=bytearray(tail)
                    if input_state['body'] is None:
                        input_state['body']=bytes(line);first.set()
                    else:
                        if json.loads(line)!= {'cancel':True}:input_state['error']=True
                        cancelled.set()
        except BaseException:input_state['error']=True;cancelled.set()
        finally:first.set();reader_done.set()
    process=None;k=None;job=None;attributes=None;handles=[];threads=[]
    streams={'out':bytearray(),'err':bytearray(),'overflow':False,'error':False}
    try:
        need(os.name=='nt' and len(sys.argv)==1,'ocr_unavailable')
        input_thread=threading.Thread(target=input_reader,daemon=True);input_thread.start()
        need(first.wait(max(0,deadline-time.monotonic())) and input_state['body'] is not None,'ocr_input_limit')
        need(not input_state['error'],'ocr_invalid_request')
        request=json.loads(input_state['body'])
        need(isinstance(request,dict),'ocr_invalid_request')
        keys={'action'} if request.get('action')=='health' else {'action','imageBase64','mimeType','language'}
        need(set(request)==keys and request.get('action') in ('health','recognize'),'ocr_invalid_request')
        need(not cancelled.is_set(),'ocr_cancelled')
        need(POWERSHELL.is_file() and SCRIPT.is_file() and DEFINITIONS.is_file(),'ocr_unavailable')
        identity={'helperSha256':sha(SCRIPT),'launcherSha256':sha(Path(__file__)),'jobDefinitionsSha256':sha(DEFINITIONS)}
        result['identity']=identity
        spec=importlib.util.spec_from_file_location('ocr_job_definitions',DEFINITIONS)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        k=module.kernel_api();process=module.PROCESS_INFORMATION()
        job=k.CreateJobObjectW(None,None);need(job,'ocr_job_unavailable')
        resource['jobClosed']=False
        limits=module.EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags=0x2308;limits.BasicLimitInformation.ActiveProcessLimit=1
        limits.ProcessMemoryLimit=limits.JobMemoryLimit=MEMORY
        need(k.SetInformationJobObject(job,9,C.byref(limits),C.sizeof(limits)),'ocr_job_unavailable')
        observed=module.EXTENDED_LIMIT_INFORMATION()
        need(k.QueryInformationJobObject(job,9,C.byref(observed),C.sizeof(observed),None)
             and observed.BasicLimitInformation.LimitFlags&0x2308==0x2308
             and observed.BasicLimitInformation.ActiveProcessLimit==1
             and observed.ProcessMemoryLimit==MEMORY and observed.JobMemoryLimit==MEMORY,'ocr_job_unavailable')
        sa=module.SECURITY_ATTRIBUTES(C.sizeof(module.SECURITY_ATTRIBUTES),None,True);pipes=[]
        for _ in range(3):
            read,write=W.HANDLE(),W.HANDLE()
            need(k.CreatePipe(C.byref(read),C.byref(write),C.byref(sa),16384),'ocr_process_failed')
            handles.extend([read.value,write.value]);pipes.append((read.value,write.value))
        child_in,parent_in=pipes[0];parent_out,child_out=pipes[1];parent_err,child_err=pipes[2]
        for handle in (parent_in,parent_out,parent_err):need(k.SetHandleInformation(handle,1,0),'ocr_process_failed')
        size=C.c_size_t();k.InitializeProcThreadAttributeList(None,1,0,C.byref(size));need(0<size.value<=65536,'ocr_process_failed')
        storage=C.create_string_buffer(size.value);attributes=C.cast(storage,W.LPVOID)
        need(k.InitializeProcThreadAttributeList(attributes,1,0,C.byref(size)),'ocr_process_failed')
        allowed=(W.HANDLE*3)(child_in,child_out,child_err)
        need(k.UpdateProcThreadAttribute(attributes,0,0x20002,allowed,C.sizeof(allowed),None,None),'ocr_process_failed')
        startup=module.STARTUPINFOEX();startup.StartupInfo.cb=C.sizeof(startup)
        startup.StartupInfo.dwFlags=0x100|1;startup.StartupInfo.wShowWindow=0
        startup.StartupInfo.hStdInput,startup.StartupInfo.hStdOutput,startup.StartupInfo.hStdError=child_in,child_out,child_err
        startup.lpAttributeList=attributes
        command=C.create_unicode_buffer(subprocess.list2cmdline([str(POWERSHELL),'-NoLogo','-NoProfile','-NonInteractive','-MTA','-ExecutionPolicy','Bypass','-File',str(SCRIPT)]))
        environment={name:os.environ[name] for name in ('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','LANG') if name in os.environ}
        environment['PATH']=str(Path(os.environ['SystemRoot'])/'System32')
        block=C.create_unicode_buffer('\0'.join(key+'='+value for key,value in sorted(environment.items(),key=lambda pair:pair[0].upper()))+'\0\0')
        need(not cancelled.is_set(),'ocr_cancelled')
        need(k.CreateProcessW(str(POWERSHELL),command,None,None,True,0x08000000|4|0x400|0x80000,block,str(ROOT),C.byref(startup),C.byref(process)),'ocr_process_failed')
        resource.update(notCreated=False,childExited=False,stdioDrained=False,childPid=process.dwProcessId,activeProcesses=None)
        need(k.AssignProcessToJobObject(job,process.hProcess),'ocr_job_unavailable')
        member=W.BOOL();need(k.IsProcessInJob(process.hProcess,job,C.byref(member)) and member.value,'ocr_job_unavailable')
        resource['jobVerifiedBeforeResume']=True
        for handle in (child_in,child_out,child_err):k.CloseHandle(handle);handles.remove(handle)
        import msvcrt
        done=[threading.Event() for _ in range(3)]
        def read_stream(handle,key,event):
            descriptor=msvcrt.open_osfhandle(handle,os.O_RDONLY|os.O_BINARY)
            try:
                cap=250000 if key=='out' else 8192
                while True:
                    chunk=os.read(descriptor,min(4096,cap+1-len(streams[key])))
                    if not chunk:break
                    streams[key].extend(chunk)
                    if len(streams[key])>cap:streams['overflow']=True;break
            except OSError:streams['error']=True
            finally:os.close(descriptor);event.set()
        def write_stream(handle,event):
            descriptor=msvcrt.open_osfhandle(handle,os.O_WRONLY|os.O_BINARY)
            try:
                offset=0
                while offset<len(input_state['body']):
                    count=os.write(descriptor,input_state['body'][offset:offset+65536]);need(count>0,'ocr_process_failed');offset+=count
            except BaseException:streams['error']=True
            finally:os.close(descriptor);event.set()
        need(not cancelled.is_set(),'ocr_cancelled')
        need(k.ResumeThread(process.hThread)!=0xffffffff,'ocr_process_failed')
        k.CloseHandle(process.hThread);process.hThread=None
        for handle,target,args in [(parent_out,read_stream,(parent_out,'out',done[0])),(parent_err,read_stream,(parent_err,'err',done[1])),(parent_in,write_stream,(parent_in,done[2]))]:
            thread=threading.Thread(target=target,args=args,daemon=True);thread.start();threads.append(thread);handles.remove(handle)
        while True:
            need(not cancelled.is_set(),'ocr_cancelled')
            need(time.monotonic()<deadline,'ocr_timeout')
            need(not streams['overflow'],'ocr_output_limit')
            if k.WaitForSingleObject(process.hProcess,20)==0 and all(event.is_set() for event in done):break
        status=W.DWORD();need(k.GetExitCodeProcess(process.hProcess,C.byref(status)),'ocr_process_failed')
        resource['exitCode']=status.value
        need(not streams['error'],'ocr_process_failed')
        native=json.loads(streams['out'].decode('utf-8-sig'))
        need(isinstance(native,dict),'ocr_native_failed')
        result['native']=native;result['ok']=status.value==0 and native.get('ok') is True
        result['code']='ok' if result['ok'] else native.get('code','ocr_native_failed')
    except BaseException as error:
        result['ok']=False;result['code']=error.code if isinstance(error,BoundError) else 'ocr_native_failed'
    finally:
        if job:k.TerminateJobObject(job,1)
        if process and process.hProcess:
            if k.WaitForSingleObject(process.hProcess,0)!=0:k.TerminateProcess(process.hProcess,1)
            resource['childExited']=k.WaitForSingleObject(process.hProcess,1000)==0
        if job:
            class Accounting(C.Structure):
                _fields_=[('times',C.c_longlong*4),('pageFaults',W.DWORD),('total',W.DWORD),('active',W.DWORD),('terminated',W.DWORD)]
            end=time.monotonic()+.5
            while True:
                accounting=Accounting()
                if not k.QueryInformationJobObject(job,1,C.byref(accounting),C.sizeof(accounting),None):resource['activeProcesses']=None;break
                resource['activeProcesses']=accounting.active
                if not accounting.active or time.monotonic()>=end:break
                time.sleep(.01)
        for thread in threads:thread.join(timeout=.2)
        if threads:resource['stdioDrained']=all(not thread.is_alive() for thread in threads)
        elif not resource['notCreated']:resource['stdioDrained']=True
        if job:resource['jobClosed']=bool(k.CloseHandle(job))
        if process and process.hProcess:k.CloseHandle(process.hProcess)
        if process and process.hThread:k.CloseHandle(process.hThread)
        if attributes:k.DeleteProcThreadAttributeList(attributes)
        for handle in handles:k.CloseHandle(handle)
        resource['cleanupConfirmed']=bool(resource['childExited'] and resource['activeProcesses']==0 and resource['stdioDrained'] and resource['jobClosed'])
        resource['elapsedMs']=round((time.monotonic()-started)*1000)
        if not resource['cleanupConfirmed']:result['ok']=False;result['code']='ocr_cleanup_unknown'
        encoded=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        if len(encoded)>MAX_OUTPUT:
            result.pop('native',None);result['ok']=False;result['code']='ocr_output_limit'
            encoded=json.dumps(result,separators=(',',':')).encode()
        offset=0
        while offset<len(encoded):
            written=os.write(1,encoded[offset:offset+65536])
            if written<=0:raise OSError('OCR response pipe closed')
            offset+=written
    return 0 if result['ok'] else 1

if __name__=='__main__':raise SystemExit(main())
