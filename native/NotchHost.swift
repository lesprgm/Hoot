import AppKit
import CoreGraphics
import Foundation

private final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class NotchSurfaceView: NSView {
    private var idleImage: NSImage?
    private var workingImage: NSImage?
    private var frameIndex = 0
    private var animationTimer: Timer?

    var spriteState = "idle" {
        didSet { setNeedsDisplay(bounds) }
    }
    var progress: CGFloat?
    var focused = false
    var extensionHeight: CGFloat = 44
    var hardwareNotchHeight: CGFloat = 32

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false
        animationTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
            guard let self else { return }
            frameIndex = (frameIndex + 1) % 8
            setNeedsDisplay(bounds)
        }
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    deinit {
        animationTimer?.invalidate()
    }

    func loadSprites(from directory: String?) {
        guard let directory else { return }
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        idleImage = loadSprite(at: root.appendingPathComponent("owl-idle.png"))
        workingImage = loadSprite(at: root.appendingPathComponent("owl-working.png"))
        setNeedsDisplay(bounds)
    }

    private func loadSprite(at url: URL) -> NSImage? {
        guard let image = NSImage(contentsOf: url), let representation = image.representations.first else {
            return nil
        }
        // The generated PNGs contain display-density metadata, so NSImage's
        // default point size is larger than its pixel grid. Sprite source
        // rectangles use pixels; normalize the logical size before cropping.
        image.size = NSSize(width: representation.pixelsWide, height: representation.pixelsHigh)
        return image
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawSurface()

        let image = isWorking ? workingImage : idleImage
        let spriteSize = min(28, max(20, hardwareNotchHeight - 4))
        let spriteRect = NSRect(
            x: bounds.midX - spriteSize / 2,
            y: max(4, (extensionHeight - spriteSize) / 2),
            width: spriteSize,
            height: spriteSize
        )

        drawGlow(in: spriteRect)
        if let image {
            drawFrame(from: image, in: spriteRect)
        } else {
            drawPlaceholder(in: spriteRect)
        }
        drawProgress(in: spriteRect)
    }

    private var isWorking: Bool {
        spriteState == "thinking" || spriteState == "speaking" || spriteState == "computer_use_running"
    }

    private func drawSurface() {
        let radius = min(22, bounds.height * 0.28)
        let path = NSBezierPath()
        path.move(to: NSPoint(x: bounds.minX, y: bounds.maxY))
        path.line(to: NSPoint(x: bounds.maxX, y: bounds.maxY))
        path.line(to: NSPoint(x: bounds.maxX, y: bounds.minY + radius))
        path.appendArc(
            withCenter: NSPoint(x: bounds.maxX - radius, y: bounds.minY + radius),
            radius: radius,
            startAngle: 0,
            endAngle: -90,
            clockwise: true
        )
        path.line(to: NSPoint(x: bounds.minX + radius, y: bounds.minY))
        path.appendArc(
            withCenter: NSPoint(x: bounds.minX + radius, y: bounds.minY + radius),
            radius: radius,
            startAngle: -90,
            endAngle: -180,
            clockwise: true
        )
        path.line(to: NSPoint(x: bounds.minX, y: bounds.maxY))
        path.close()

        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.42)
        shadow.shadowBlurRadius = 12
        shadow.shadowOffset = NSSize(width: 0, height: -3)
        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        NSColor(calibratedWhite: 0.015, alpha: 0.985).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawFrame(from image: NSImage, in destination: NSRect) {
        let frameWidth = min(128, image.size.width)
        let frameHeight = min(128, image.size.height)
        let frameCount = max(1, Int(image.size.width / frameWidth))
        let frame = frameIndex % frameCount
        let source = NSRect(
            x: CGFloat(frame) * frameWidth,
            y: 0,
            width: frameWidth,
            height: frameHeight
        )
        image.draw(in: destination, from: source, operation: .sourceOver, fraction: 1)
    }

    private func drawPlaceholder(in rect: NSRect) {
        NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
        NSBezierPath(ovalIn: rect.insetBy(dx: 7, dy: 5)).fill()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: rect.midX - 13, y: rect.midY + 2, width: 8, height: 10)).fill()
        NSBezierPath(ovalIn: NSRect(x: rect.midX + 5, y: rect.midY + 2, width: 8, height: 10)).fill()
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: rect.midX - 10, y: rect.midY + 5, width: 3, height: 4)).fill()
        NSBezierPath(ovalIn: NSRect(x: rect.midX + 8, y: rect.midY + 5, width: 3, height: 4)).fill()
    }

    private func drawGlow(in rect: NSRect) {
        let color: NSColor
        switch spriteState {
        case "needs_confirmation": color = NSColor.systemRed
        case "success": color = NSColor.systemGreen
        case "interrupted": color = NSColor.systemOrange
        default: color = isWorking ? NSColor.systemBlue : NSColor.clear
        }
        guard color != .clear else { return }
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = color.withAlphaComponent(0.65)
        shadow.shadowBlurRadius = 14
        shadow.shadowOffset = .zero
        shadow.set()
        color.withAlphaComponent(0.16).setFill()
        NSBezierPath(ovalIn: rect.insetBy(dx: 6, dy: 6)).fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawProgress(in spriteRect: NSRect) {
        guard focused || progress != nil else { return }
        let ringPadding = max(1, (hardwareNotchHeight - spriteRect.width) / 2)
        let ringRect = spriteRect.insetBy(dx: -ringPadding, dy: -ringPadding)
        let track = NSBezierPath(ovalIn: ringRect)
        NSColor.white.withAlphaComponent(0.18).setStroke()
        track.lineWidth = 3
        track.stroke()

        guard let progress else { return }
        let value = min(1, max(0, progress))
        let ring = NSBezierPath()
        ring.appendArc(
            withCenter: NSPoint(x: ringRect.midX, y: ringRect.midY),
            radius: ringRect.width / 2,
            startAngle: 90,
            endAngle: 90 - (360 * value),
            clockwise: true
        )
        NSColor.systemBlue.setStroke()
        ring.lineWidth = 4
        ring.lineCapStyle = .round
        ring.stroke()
    }
}

private final class NotchHostController: NSObject {
    private var panel: NotchPanel?
    private var surface: NotchSurfaceView?
    private var screenObserver: NSObjectProtocol?

    init(spriteDirectory: String?) {
        super.init()
        let surface = NotchSurfaceView(frame: .zero)
        surface.loadSprites(from: spriteDirectory)
        self.surface = surface

        let panel = NotchPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = surface
        self.panel = panel

        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reposition()
        }
    }

    deinit {
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
        }
        panel?.close()
    }

    func install() {
        reposition()
        panel?.orderFrontRegardless()
    }

    func apply(_ message: [String: Any]) {
        if let sprite = message["sprite"] as? String {
            surface?.spriteState = sprite
        }
        if message.keys.contains("progress") {
            if let number = message["progress"] as? NSNumber {
                surface?.progress = CGFloat(number.doubleValue)
            } else {
                surface?.progress = nil
            }
        }
        if let focused = message["focused"] as? Bool {
            surface?.focused = focused
        }
        if let visible = message["visible"] as? Bool, !visible {
            panel?.orderOut(nil)
        } else {
            reposition()
            panel?.orderFrontRegardless()
        }
        surface?.setNeedsDisplay(surface?.bounds ?? .zero)
    }

    private func reposition() {
        guard let screen = primaryScreen(), let panel, let surface else { return }
        let geometry = notchGeometry(for: screen)
        let extensionHeight: CGFloat = geometry.hasHardwareNotch ? 44 : 52
        let panelWidth = geometry.hasHardwareNotch ? geometry.frame.width : 280
        let frame = NSRect(
            x: geometry.frame.midX - panelWidth / 2,
            y: geometry.frame.minY - extensionHeight,
            width: panelWidth,
            height: geometry.frame.height + extensionHeight
        )
        panel.setFrame(frame, display: true)
        surface.extensionHeight = extensionHeight
        surface.hardwareNotchHeight = geometry.frame.height
        surface.frame = panel.contentView?.bounds ?? .zero
    }

    private func primaryScreen() -> NSScreen? {
        let mainDisplayID = CGMainDisplayID()
        let numberKey = NSDeviceDescriptionKey("NSScreenNumber")
        return NSScreen.screens.first { screen in
            (screen.deviceDescription[numberKey] as? NSNumber)?.uint32Value == mainDisplayID
        } ?? NSScreen.screens.first
    }

    private func notchGeometry(for screen: NSScreen) -> (frame: NSRect, hasHardwareNotch: Bool) {
        let topInset = screen.safeAreaInsets.top
        if let left = screen.auxiliaryTopLeftArea?.width,
           let right = screen.auxiliaryTopRightArea?.width,
           topInset > 0 {
            let width = screen.frame.width - left - right
            return (
                NSRect(
                    x: screen.frame.midX - width / 2,
                    y: screen.frame.maxY - topInset,
                    width: width,
                    height: topInset
                ),
                true
            )
        }

        let menuBarHeight = max(24, screen.frame.maxY - screen.visibleFrame.maxY)
        return (
            NSRect(
                x: screen.frame.midX - 140,
                y: screen.frame.maxY - menuBarHeight,
                width: 280,
                height: menuBarHeight
            ),
            false
        )
    }
}

private final class NotchHostAppDelegate: NSObject, NSApplicationDelegate {
    private let spriteDirectory: String?
    private var controller: NotchHostController?

    init(spriteDirectory: String?) {
        self.spriteDirectory = spriteDirectory
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = NotchHostController(spriteDirectory: spriteDirectory)
        controller?.install()
        guard let controller else { return }

        DispatchQueue.global(qos: .utility).async {
            while let line = readLine(),
                  let data = line.data(using: .utf8),
                  let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                DispatchQueue.main.async {
                    controller.apply(message)
                }
            }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }
}

@main
private struct NotchHostMain {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let spriteDirectory = CommandLine.arguments.dropFirst().first
        let delegate = NotchHostAppDelegate(spriteDirectory: spriteDirectory)
        application.delegate = delegate
        application.run()
    }
}
