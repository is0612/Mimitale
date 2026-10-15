<#
  clear-low-integrity.ps1 —— 清掉「低完整性标签」（Mandatory Integrity Label）

  为什么需要它
  ------------
  会话沙箱会给它动过的目录（工作区）整棵打上**低完整性标签**，连里面的
  `node_modules\electron\dist\electron.exe` 也是。进程的完整性级别 =
  **min(启动它的令牌, exe 文件自己的标签)** —— 所以从哪启动、用什么身份启动，
  这个程序都跑在 Low 上（2026-10-08 / 10-10 查到底的机制，见 CHANGELOG）。

  Low 进程的两个后果（本机实测，2026-10-16）：
    · 写不了任何中完整性的位置：桌面 / 下载 / 图片 / `%TEMP%` / `%APPDATA%` 一律 EPERM；
    · 读「桌面」也被拒（`readdir` → EPERM），于是点「导入角色卡」时系统文件框
      会弹自己的框：「你当前无权访问该文件夹。单击"继续"获取永久访问该文件夹的权限。」
      —— 标题就是这个文件夹的名字（Desktop）。那句框不是本项目说的。

  清掉标签之后进程恢复 Medium，桌面能读能写，那个框就没了。

  用法
  ----
    # 只看现状（不需要管理员）
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\clear-low-integrity.ps1

    # 真正清一遍（**需要管理员权限**：改标签要 SeSecurityPrivilege）
    # 以管理员身份打开 PowerShell，cd 到 client\ 再跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\clear-low-integrity.ps1 -Fix

    # 顺带把「关闭 Electron 沙箱」的兜底标记删掉（标签清干净后沙箱能正常起来了）
    ... -Fix -ResetSandboxMarker

    # 还要清别的位置（默认只清本程序所在的 client\ 整棵）
    ... -Fix -Path D:\AI\Mimitale

  安全性
  ------
  只动**完整性标签**这一项（`LABEL_SECURITY_INFORMATION`），
  不碰属主、不碰权限项（DACL）、不改文件内容。要恢复标签：
    icacls <目录> /setintegritylevel (OI)(CI)Low /T
#>
[CmdletBinding()]
param(
  # 要处理的根目录。默认 = 本脚本上一级（client\，也就是程序自己那棵树）
  [string[]]$Path,
  # 不加 -Fix 只报告；加了才清
  [switch]$Fix,
  # 清完之后删掉「关闭 Electron 沙箱」的兜底标记（让下次启动重新试一次沙箱）
  [switch]$ResetSandboxMarker
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot            # …\client
$roots = if ($Path) { $Path } else { @($appRoot) }

Write-Host ''
Write-Host 'Mimitale —— 低完整性标签（Low Mandatory Level）检查/清理'
Write-Host ('  程序目录：{0}' -f $appRoot)
Write-Host ('  处理范围：{0}' -f ($roots -join '、'))
Write-Host ''

# --- 1. 读/清标签的底层调用（放在 C# 里，比在 PowerShell 里玩指针稳） ------------

# ⚠️ -MemberDefinition 会把这段代码包进一个类里，所以这里只能写**类成员**
#    （字段 / DllImport / 方法），不能写 using ——
#    Add-Type 的默认模板已经带了 using System; 和 using System.Runtime.InteropServices;
Add-Type -Namespace Mimitale -Name IntegrityLabel -MemberDefinition @'
const uint LABEL_SECURITY_INFORMATION = 0x00000010;
const int  SE_FILE_OBJECT            = 1;
const byte SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern uint GetNamedSecurityInfoW(string objectName, int objectType, uint securityInfo,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern uint SetNamedSecurityInfoW(string objectName, int objectType, uint securityInfo,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

[DllImport("advapi32.dll", SetLastError = true)]
static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);

[DllImport("advapi32.dll", SetLastError = true)]
static extern bool GetAclInformation(IntPtr acl, IntPtr info, uint len, int infoClass);

[DllImport("advapi32.dll", SetLastError = true)]
static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);

[DllImport("kernel32.dll")]
static extern IntPtr LocalFree(IntPtr h);

/// 返回这个对象的完整性标签：中文短名 + 策略；没有标签返回「无标签」
public static string Describe(string path)
{
    IntPtr sd = IntPtr.Zero;
    uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
    if (rc != 0) return "读取失败(" + rc + ")";
    try
    {
        bool present; IntPtr sacl; bool def;
        if (!GetSecurityDescriptorSacl(sd, out present, out sacl, out def)) return "读取失败(SACL)";
        if (!present || sacl == IntPtr.Zero) return "无标签";

        IntPtr sizeInfo = Marshal.AllocHGlobal(16);
        int aceCount = 0;
        try
        {
            if (GetAclInformation(sacl, sizeInfo, 16, 2)) aceCount = Marshal.ReadInt32(sizeInfo, 0);
        }
        finally { Marshal.FreeHGlobal(sizeInfo); }

        for (uint i = 0; i < aceCount; i++)
        {
            IntPtr ace;
            if (!GetAce(sacl, i, out ace)) continue;
            if (Marshal.ReadByte(ace, 0) != SYSTEM_MANDATORY_LABEL_ACE_TYPE) continue;
            if (Marshal.ReadInt16(ace, 2) < 20) continue;          // 结构不对就别读了
            uint mask = (uint)Marshal.ReadInt32(ace, 4);
            // ⚠️ 强制性标签 ACE 里的 SID 是**内联**的（紧跟在 ACE 头上，偏移 8），
            //    不是指针 —— 按指针读会读到垃圾地址，然后就是 AccessViolation。
            //    这里的 SID 形状固定：Rev(1) + 子权限个数(1) + 颁发者(6) + 子权限(4×n)，
            //    完整性级别就是**最后一个子权限**（小端 DWORD）。所以直接按字节拼，
            //    不调 GetSidSubAuthority —— 那个调用在本机实测读出来的值是错的。
            int sidOff = 8;
            int cnt = Marshal.ReadByte(ace, sidOff + 1);
            if (cnt < 1) return "标签结构异常";
            int subOff = sidOff + 8 + (cnt - 1) * 4;
            int rid = Marshal.ReadByte(ace, subOff)
                    | (Marshal.ReadByte(ace, subOff + 1) << 8)
                    | (Marshal.ReadByte(ace, subOff + 2) << 16)
                    | (Marshal.ReadByte(ace, subOff + 3) << 24);
            string level = rid == 0 ? "Untrusted" : rid == 0x1000 ? "Low" : rid == 0x2000 ? "Medium"
                         : rid == 0x3000 ? "High" : ("0x" + rid.ToString("X"));
            string pol = "";
            if ((mask & 0x1) != 0) pol += "NW";                    // 不许往上写
            if ((mask & 0x2) != 0) pol += (pol.Length > 0 ? "+" : "") + "NR";   // 不许往上读
            if ((mask & 0x4) != 0) pol += (pol.Length > 0 ? "+" : "") + "NX";
            return level + "(" + (pol.Length == 0 ? "policy=none" : pol) + ")";
        }
        return "无标签";
    }
    finally { LocalFree(sd); }
}

/// 去掉标签：只传 LABEL_SECURITY_INFORMATION + 空的 SACL。返回 0 = 成功
public static int Remove(string path)
{
    uint rc = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    return (int)rc;
}
'@

function Get-Label([string]$p) { [Mimitale.IntegrityLabel]::Describe($p) }
function Remove-Label([string]$p) { [Mimitale.IntegrityLabel]::Remove($p) }

# SetNamedSecurityInfo 不吃相对路径；长路径要 \\?\ 前缀
function Resolve-ApiPath([string]$p) {
  $full = [System.IO.Path]::GetFullPath($p)
  if ($full.StartsWith('\\?\')) { return $full }
  if ($full.Length -ge 240) { return '\\?\' + $full }
  return $full
}

# --- 2. 现状 ----------------------------------------------------------------

$managed = @(
  @{ Name = '程序目录'; Path = $appRoot },
  @{ Name = 'electron.exe'; Path = (Join-Path $appRoot 'node_modules\electron\dist\electron.exe') },
  @{ Name = '数据目录'; Path = (Join-Path $appRoot 'data') },
  @{ Name = '桌面（对照，应为 Medium/无标签）'; Path = (Join-Path $env:USERPROFILE 'Desktop') }
)

Write-Host '现在的标签：'
foreach ($m in $managed) {
  if (Test-Path -LiteralPath $m.Path) {
    Write-Host ('  {0,-34} {1,-14} {2}' -f $m.Name, (Get-Label $m.Path), $m.Path)
  } else {
    Write-Host ('  {0,-34} {1,-14} {2}' -f $m.Name, '(不存在)', $m.Path)
  }
}

$lowOnApp = (Get-Label $appRoot) -like 'Low*'
if (-not $lowOnApp) {
  Write-Host ''
  Write-Host '程序目录上没有 Low 标签 —— 这个症状不是它引起的，先别清。'
  if ($Fix) { Write-Host '（-Fix 已忽略）' }
  $Fix = $false
}

# --- 3. 清 ------------------------------------------------------------------

if ($Fix) {
  $isAdmin = ([Security.Principal.WindowsPrincipal]::new(
      [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host ''
    Write-Host '要清标签需要管理员权限（改标签要 SeSecurityPrivilege）。'
    Write-Host '做法：开始菜单搜「PowerShell」→ 右键「以管理员身份运行」→ 然后跑：'
    Write-Host ('  cd "{0}"' -f $appRoot)
    Write-Host '  npm run fix:integrity'
    Write-Host '（不想用 npm 就等价地跑：）'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\clear-low-integrity.ps1 -Fix'
    exit 1
  }

  Write-Host ''
  Write-Host '开始清理（只动完整性标签，不碰属主 / 权限项 / 文件内容）……'

  $ok = 0
  $fail = 0
  $failSamples = New-Object System.Collections.ArrayList
  $seen = 0

  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) {
      Write-Host ('  {0} 不存在，跳过' -f $root)
      continue
    }

    $stack = New-Object System.Collections.Stack
    $stack.Push([System.IO.Path]::GetFullPath($root))

    while ($stack.Count -gt 0) {
      $cur = $stack.Pop()
      $apiPath = Resolve-ApiPath $cur

      $rc = Remove-Label $apiPath
      if ($rc -eq 0) { $ok++ } else {
        $fail++
        if ($failSamples.Count -lt 5) { $null = $failSamples.Add(('{0} → 错误 {1}' -f $cur, $rc)) }
      }
      $seen++
      if ($seen % 2000 -eq 0) { Write-Host ('  已处理 {0} 个对象……' -f $seen) }

      # 子项：目录压栈，文件就地处理
      try {
        foreach ($child in [System.IO.Directory]::GetFileSystemEntries($apiPath)) {
          if ([System.IO.Directory]::Exists($child)) { $stack.Push($child) }
          else {
            $rcFile = Remove-Label $child
            if ($rcFile -eq 0) { $ok++ } else {
              $fail++
              if ($failSamples.Count -lt 5) { $null = $failSamples.Add(('{0} → 错误 {1}' -f $child, $rcFile)) }
            }
          }
        }
      } catch {
        $fail++
        if ($failSamples.Count -lt 5) { $null = $failSamples.Add(('{0} → 列不出来：{1}' -f $cur, $_.Exception.Message)) }
      }
    }
  }

  Write-Host ''
  Write-Host ('清完：成功 {0} 个对象，失败 {1} 个' -f $ok, $fail)
  foreach ($s in $failSamples) { Write-Host ('  失败样例：{0}' -f $s) }

  Write-Host ''
  Write-Host '复查：'
  foreach ($m in $managed) {
    if (Test-Path -LiteralPath $m.Path) {
      Write-Host ('  {0,-34} {1,-14} {2}' -f $m.Name, (Get-Label $m.Path), $m.Path)
    }
  }

  # 新建的对象不该再继承 Low —— 顺手验一下（建一个临时目录再删掉）
  $probe = Join-Path $appRoot ('_il_check_' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  try {
    New-Item -ItemType Directory -Path $probe -Force | Out-Null
    Write-Host ('  新目录（应显示「无标签」）         {0,-14} {1}' -f (Get-Label $probe), $probe)
  } catch {
    Write-Host ('  新目录建不出来：{0}' -f $_.Exception.Message)
  } finally {
    Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
  }

  if ($ResetSandboxMarker) {
    $marker = Join-Path $appRoot '.mimitale-no-sandbox'
    if (Test-Path -LiteralPath $marker) {
      Remove-Item -LiteralPath $marker -Force
      Write-Host ''
      Write-Host '已删掉 .mimitale-no-sandbox —— 下次启动会重新试一次 Electron 自带的沙箱。'
    }
  } else {
    $marker = Join-Path $appRoot '.mimitale-no-sandbox'
    if (Test-Path -LiteralPath $marker) {
      Write-Host ''
      Write-Host '提示：程序目录里还有 .mimitale-no-sandbox（启动器记着「这台机器要关沙箱」）。'
      Write-Host '      标签清干净后 Electron 沙箱通常就正常了，可以加 -ResetSandboxMarker 把它删掉，'
      Write-Host '      下次启动重新试一次；要是又崩（返回码 -2147483645），启动器会自己写回来。'
    }
  }

  Write-Host ''
  Write-Host '下一步：完全退出 Mimitale（连托盘一起）再重新启动，然后试一次「导入角色卡」。'
  Write-Host '如果以后又出现同样的框，就是沙箱又给项目目录打了标签 —— 重跑本脚本即可。'
} else {
  Write-Host ''
  Write-Host '只报告不改。要清就加 -Fix（并确保是管理员身份）。'
  if ($lowOnApp) {
    Write-Host ''
    Write-Host '也可以不改标签：把整个 Mimitale 文件夹复制到没被沙箱动过的地方'
    Write-Host '（例如 D:\Mimitale）再启动 —— 复制出来的文件会继承新位置的标签（通常是中完整性）。'
  }
}
