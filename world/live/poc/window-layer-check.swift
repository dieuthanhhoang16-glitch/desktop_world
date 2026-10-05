// world/live/poc/window-layer-check.swift
// PoC 验证器：用公开 API CGWindowListCopyWindowInfo 打印屏幕上各层窗口，
// 确认我们的窗口 layer 是否落到桌面层（kCGDesktopWindowLevel = -2147483624）。
// 用法：/tmp/window-layer-check <进程名关键字>      例：/tmp/window-layer-check dwpoc
import Cocoa

let keyword = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
// 注意：不能带 .excludeDesktopElements——落到桌面层的窗口正是"desktop element"
let opts: CGWindowListOption = [.optionOnScreenOnly]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
  fputs("CGWindowList 读取失败\n", stderr)
  exit(1)
}

var hits: [(pid: Int32, layer: Int, name: String, owner: String, bounds: Any)] = []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  guard keyword.isEmpty || owner.localizedCaseInsensitiveContains(keyword)
        || name.localizedCaseInsensitiveContains(keyword) else { continue }
  hits.append((
    pid: w[kCGWindowOwnerPID as String] as? Int32 ?? -1,
    layer: w[kCGWindowLayer as String] as? Int ?? .max,
    name: name,
    owner: owner,
    bounds: w[kCGWindowBounds as String] ?? [:]
  ))
}

let desktop = CGWindowLevelForKey(.desktopWindow)
let desktopIcon = CGWindowLevelForKey(.desktopIconWindow)
print("参照值: kCGDesktopWindowLevel=\(desktop)  kCGDesktopIconWindowLevel=\(desktopIcon)")

for h in hits {
  print("pid=\(h.pid) layer=\(h.layer) owner=\(h.owner) name=\(h.name)")
}
if hits.isEmpty {
  print("❌ 没找到匹配窗口")
  exit(2)
} else if hits.contains(where: { $0.layer == Int(desktop) || $0.layer == Int(desktop) + 1 }) {
  print("✅ 目标窗口已落在图标下方桌面层")
} else {
  print("⚠️ 目标窗口不在桌面层（见上方 layer 值）")
  exit(3)
}
