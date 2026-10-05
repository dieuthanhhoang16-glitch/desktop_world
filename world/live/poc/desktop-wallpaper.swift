// world/live/poc/desktop-wallpaper.swift
// v0.6 PoC：macOS「图标下方桌面层」可行性验证（招式源自 Plash 开源快照 DesktopWindow.swift，
// 此处为独立最简重写）。用 WKWebView 渲染早报模板证明：透明渲染管线 + 桌面层 + 点击穿透
// 三者可以共存。
//
// 编译：swiftc -O world/live/poc/desktop-wallpaper.swift -o /tmp/dwpoc -framework Cocoa -framework WebKit
// 运行：/tmp/dwpoc [要加载的 html 路径，默认 world/out/.daily-card.render.html]
// 退出：kill <pid>
import Cocoa
import WebKit

// ── 桌面层窗口：Plash 招式的最小复现 ──
//   level = .desktop               图标下层
//   collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]
//                                  跨 Space 钉住 / 不进 Cmd+Tab 轮换 / 不与全屏空间纠缠
//   ignoresMouseEvents = true      点击落到图标上
final class DesktopWindow: NSWindow {
  override var canBecomeMain: Bool { false }
  override var canBecomeKey: Bool { false }

  convenience init() {
    self.init(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
    isOpaque = false
    backgroundColor = .clear
    // 新 SDK 的 Swift 命名空间没有 .desktop 糖，直接用公开常量 kCGDesktopWindowLevel
    level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
    isRestorable = false
    canHide = false
    ignoresMouseEvents = true
    collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]
    // 铺满主屏（PoC 不处理多屏与分辨率变化，生产版再跟 NSScreen 参数变化通知）
    if let screen = NSScreen.main { setFrame(screen.frame, display: true) }
  }
}

final class PoCApp: NSObject, NSApplicationDelegate {
  var window: DesktopWindow!

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = DesktopWindow()
    let webView = WKWebView(frame: window.frame, configuration: WKWebViewConfiguration())
    webView.setValue(false, forKey: "drawsBackground") // 让上层的透明透出桌面
    window.contentView = webView

    let htmlPath = CommandLine.arguments.count > 1
      ? CommandLine.arguments[1]
      : FileManager.default.currentDirectoryPath + "/world/out/.daily-card.render.html"
    webView.loadFileURL(URL(fileURLWithPath: htmlPath), allowingReadAccessTo: URL(fileURLWithPath: htmlPath))

    window.orderBack(nil)
    NSLog("[dwpoc] 桌面层窗口已就位，level=\(window.level.rawValue)")
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不进 Dock
let pocDelegate = PoCApp() // NSApplication.delegate 是 weak，必须强引用挂住
app.delegate = pocDelegate
app.run()
