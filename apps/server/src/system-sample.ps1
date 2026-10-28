# ASTRA system sampler — one long-lived PowerShell process that prints one compact
# JSON line every N milliseconds. Spawned once by src/system.mjs and restarted if
# it ever exits. Read-only: it only queries performance counters / CIM / .NET APIs.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File system-sample.ps1 -IntervalMs 2000
#
# Line shape (consumed by src/system.mjs):
#   {at, cpu:{usage,perCore[]}, mem:{usedBytes,totalBytes,usedPct},
#    disks:[{name,totalBytes,freeBytes,usedPct}],
#    net:{rxBps,txBps,totalRxBytes,totalTxBytes},
#    procs:[{pid,name,cpuPct,memBytes}], uptimeSec, battery:{percent,charging}|null}

param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'SilentlyContinue'
$out = [Console]::Out
$interval = [Math]::Max(500, $IntervalMs)

# --- total physical memory (P/Invoke compiled once) -------------------------
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AstraNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    // Environment.TickCount64 is .NET Core only; PowerShell 5.1 runs on .NET
    // Framework, so read the kernel counter directly for seconds-since-boot.
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
}
'@
} catch {
    # Type may already exist in this AppDomain; ignore.
}

function Get-MemoryStatus {
    $status = New-Object 'AstraNative+MEMORYSTATUSEX'
    $status.dwLength = [System.Runtime.InteropServices.Marshal]::SizeOf($status)
    $ok = [AstraNative]::GlobalMemoryStatusEx([ref]$status)
    if (-not $ok) { return $null }
    return $status
}

# --- CPU counters (created once, polled every sample) ----------------------
$procCounters = @()
$totalCounter = $null
try {
    $category = New-Object System.Diagnostics.PerformanceCounterCategory('Processor')
    $instances = @($category.GetInstanceNames())
    $totalCounter = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total')
    foreach ($instance in $instances) {
        if ($instance -eq '_Total') { continue }
        try {
            if ($instance -match '^\d+$') {
                $procCounters += New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', $instance)
            }
        } catch { }
    }
} catch { }

$memCounter = $null
try {
    $memCounter = New-Object System.Diagnostics.PerformanceCounter('Memory', 'Available MBytes')
} catch { }

$coreCount = [Environment]::ProcessorCount
if ($coreCount -lt 1) { $coreCount = 1 }

# Warm the counters so the first real sample has a usable delta.
if ($totalCounter) { [void]$totalCounter.NextValue() }
foreach ($counter in $procCounters) { [void]$counter.NextValue() }
Start-Sleep -Milliseconds 250

$prevProc = @{}
$prevProcAt = $null
$prevNet = $null
$prevNetAt = $null
$batteryCache = $null

function Get-NetTotals {
    $rx = [long]0
    $tx = [long]0
    try {
        $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
        foreach ($nic in $interfaces) {
            if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
            if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Tunnel) { continue }
            $stats = $nic.GetIPv4Statistics()
            if ($stats) {
                $rx += [long]$stats.BytesReceived
                $tx += [long]$stats.BytesSent
            }
        }
    } catch { }
    return @($rx, $tx)
}

$loop = 0
while ($true) {
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $loop++

    # --- CPU ---------------------------------------------------------------
    $perCore = @()
    $usage = 0.0
    if ($totalCounter) {
        $usage = [Math]::Round($totalCounter.NextValue() / 100.0, 4)
        foreach ($counter in $procCounters) {
            $perCore += [Math]::Round($counter.NextValue() / 100.0, 4)
        }
    }

    # --- memory ------------------------------------------------------------
    $memStatus = Get-MemoryStatus
    $totalBytes = [long]0
    $usedBytes = [long]0
    $usedPct = 0.0
    if ($memStatus) {
        $totalBytes = [long]$memStatus.ullTotalPhys
        $usedBytes = [long]($memStatus.ullTotalPhys - $memStatus.ullAvailPhys)
        if ($totalBytes -gt 0) { $usedPct = [Math]::Round($usedBytes / $totalBytes, 4) }
    }

    # --- disks -------------------------------------------------------------
    $disks = @()
    try {
        foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
            if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { continue }
            $total = [long]$drive.TotalSize
            $free = [long]$drive.AvailableFreeSpace
            if ($total -le 0) { continue }
            $disks += @{
                name = $drive.Name
                totalBytes = $total
                freeBytes = $free
                usedPct = [Math]::Round(1.0 - ($free / $total), 4)
            }
        }
    } catch { }

    # --- network -----------------------------------------------------------
    $netPair = Get-NetTotals
    $rxTotal = [long]$netPair[0]
    $txTotal = [long]$netPair[1]
    $rxBps = 0.0
    $txBps = 0.0
    if ($prevNet -and $prevNetAt) {
        $elapsedMs = [Math]::Max(1, $nowMs - $prevNetAt)
        $rxBps = [Math]::Round((($rxTotal - $prevNet[0]) * 1000.0) / $elapsedMs, 0)
        $txBps = [Math]::Round((($txTotal - $prevNet[1]) * 1000.0) / $elapsedMs, 0)
        if ($rxBps -lt 0) { $rxBps = 0.0 }
        if ($txBps -lt 0) { $txBps = 0.0 }
    }
    $prevNet = @($rxTotal, $txTotal)
    $prevNetAt = $nowMs

    # --- processes (v2.5 百工：全进程；采样器最多输出 $procLimit 条) ---------
    $procLimit = 200
    if ($env:PROC_LIMIT) { try { $procLimit = [Math]::Max(16, [int]$env:PROC_LIMIT) } catch { } }
    $procs = @()
    $nextPrev = @{}
    $procAt = $nowMs
    try {
        $elapsedCpuMs = 1
        if ($prevProcAt) { $elapsedCpuMs = [Math]::Max(1, $procAt - $prevProcAt) }
        foreach ($process in (Get-Process)) {
            $cpuDeltaMs = 0.0
            $previous = $prevProc[$process.Id]
            if ($previous -and $prevProcAt) {
                $cpuDeltaMs = $process.TotalProcessorTime.TotalMilliseconds - $previous
                if ($cpuDeltaMs -lt 0) { $cpuDeltaMs = 0 }
            }
            $cpuPct = [Math]::Round(($cpuDeltaMs / $elapsedCpuMs) * 100.0 / $coreCount, 1)
            $threadCount = 0
            try { $threadCount = $process.Threads.Count } catch { }
            $nextPrev[$process.Id] = $process.TotalProcessorTime.TotalMilliseconds
            $procs += @{
                pid = $process.Id
                name = $process.ProcessName
                cpuPct = $cpuPct
                memBytes = [long]$process.WorkingSet64
                threads = $threadCount
                _cpu = $cpuDeltaMs
            }
        }
    } catch { }
    $prevProc = $nextPrev
    $prevProcAt = $procAt
    $procs = @($procs | Sort-Object -Property @{ Expression = { $_.cpuPct }; Descending = $true }, @{ Expression = { $_.memBytes }; Descending = $true } | Select-Object -First $procLimit)
    $procs = @($procs | ForEach-Object {
        @{ pid = $_.pid; name = $_.name; cpuPct = $_.cpuPct; memBytes = $_.memBytes; threads = $_.threads }
    })

    # --- battery (cheap enough every 8th sample) ---------------------------
    if ($loop % 8 -eq 1) {
        try {
            $batteryInfo = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
            if ($batteryInfo) {
                $batteryCache = @{
                    percent = [int]$batteryInfo.EstimatedChargeRemaining
                    charging = ($batteryInfo.BatteryStatus -eq 2)
                }
            }
        } catch { }
    }
    $battery = $batteryCache

    # --- uptime ------------------------------------------------------------
    try {
        $uptimeSec = [Math]::Round([AstraNative]::GetTickCount64() / 1000.0, 0)
    } catch {
        $uptimeSec = 0
    }

    $sample = @{
        at = $nowMs
        cpu = @{ usage = $usage; perCore = $perCore }
        mem = @{ usedBytes = $usedBytes; totalBytes = $totalBytes; usedPct = $usedPct }
        disks = $disks
        net = @{ rxBps = $rxBps; txBps = $txBps; totalRxBytes = $rxTotal; totalTxBytes = $txTotal }
        procs = $procs
        uptimeSec = $uptimeSec
        battery = $battery
    }
    try {
        $json = $sample | ConvertTo-Json -Compress -Depth 6
        $out.WriteLine($json)
        $out.Flush()
    } catch { }

    Start-Sleep -Milliseconds $interval
}
