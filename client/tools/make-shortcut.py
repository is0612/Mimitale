# -*- coding: utf-8 -*-
"""Create a Windows .lnk shortcut via IShellLink COM (pure ctypes, no shell host).

IShellLinkW inherits IUnknown directly. vtable layout (0-based):
  IUnknown:   0 QueryInterface  1 AddRef  2 Release
  IShellLinkW: 3 GetPath  4 GetIDList  5 SetIDList
               6 GetDescription  7 SetDescription
               8 GetWorkingDirectory  9 SetWorkingDirectory
               10 GetArguments  11 SetArguments
               12 GetHotkey  13 SetHotkey
               14 GetShowCmd  15 SetShowCmd
               16 GetIconLocation  17 SetIconLocation
               18 SetRelativePath  19 Resolve  20 SetPath
IPersistFile (via QueryInterface): 0 QI 1 AddRef 2 Release 3 GetClassID
  4 IsDirty 5 Load 6 Save 7 SaveCompleted 8 GetCurFile
"""
import ctypes
import sys
from uuid import UUID


def g(s):
    return (ctypes.c_ubyte * 16).from_buffer_copy(UUID(s).bytes_le)


def make_shortcut(target, icon, workdir, out):
    ole32 = ctypes.windll.ole32

    ppv = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(
        ctypes.byref(g('{00021401-0000-0000-C000-000000000046}')),
        None, 1,
        ctypes.byref(g('{000214F9-0000-0000-C000-000000000046}')),
        ctypes.byref(ppv),
    )
    if hr != 0:
        raise RuntimeError('CoCreateInstance hr=0x%08x' % (hr & 0xffffffff))

    this = ppv.value
    v = ctypes.cast(ppv, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    W = ctypes.WINFUNCTYPE
    P = ctypes.c_void_p
    LP = ctypes.c_wchar_p

    SetPath = W(ctypes.c_long, P, LP)(v[20])
    SetDescription = W(ctypes.c_long, P, LP)(v[7])
    SetWorkingDirectory = W(ctypes.c_long, P, LP)(v[9])
    SetShowCmd = W(ctypes.c_long, P, ctypes.c_int)(v[15])
    SetIconLocation = W(ctypes.c_long, P, LP, ctypes.c_int)(v[17])

    SetPath(this, target)
    SetDescription(this, 'Mimitale')
    SetWorkingDirectory(this, workdir)
    SetShowCmd(this, 1)
    SetIconLocation(this, icon, 0)

    ipf = ctypes.c_void_p()
    QueryInterface = W(ctypes.c_long, P, ctypes.c_void_p, ctypes.POINTER(P))(v[0])
    hr = QueryInterface(this, ctypes.byref(g('{0000010B-0000-0000-C000-000000000046}')), ctypes.byref(ipf))
    if hr != 0:
        raise RuntimeError('QI IPersistFile hr=0x%08x' % (hr & 0xffffffff))

    iv = ctypes.cast(ipf, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    Save = W(ctypes.c_long, P, LP, ctypes.c_int)(iv[6])
    hr = Save(ipf.value, out, 1)
    if hr != 0:
        raise RuntimeError('IPersistFile::Save hr=0x%08x' % (hr & 0xffffffff))
    print('shortcut created: ' + out)


if __name__ == '__main__':
    target, icon, workdir, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    make_shortcut(target, icon, workdir, out)
