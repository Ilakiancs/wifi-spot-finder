// Renders the app icon (Wi-Fi waves rising from a location pin) into an .iconset folder.
// Usage: icon <output.iconset>
import AppKit

let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)

    // body: macOS-style rounded square with soft shadow
    let body = NSRect(x: 100, y: 100, width: 824, height: 824)
    let shape = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: NSColor(white: 0, alpha: 0.35).cgColor)
    NSColor.black.setFill(); shape.fill()
    ctx.restoreGState()
    ctx.saveGState()
    shape.addClip()
    NSGradient(colors: [NSColor(srgbRed: 0.06, green: 0.73, blue: 0.80, alpha: 1),
                        NSColor(srgbRed: 0.16, green: 0.38, blue: 0.95, alpha: 1),
                        NSColor(srgbRed: 0.20, green: 0.16, blue: 0.62, alpha: 1)])!
        .draw(in: body, angle: -70)
    // soft highlight at the top
    NSGradient(colors: [NSColor(white: 1, alpha: 0.18), NSColor(white: 1, alpha: 0)])!
        .draw(in: NSRect(x: 100, y: 560, width: 824, height: 364), angle: -90)
    ctx.restoreGState()

    // Wi-Fi arcs, centred on the pin head; outer arcs slightly fainter
    let c = CGPoint(x: 512, y: 430)
    for (r, a) in [(165.0, 1.0), (265.0, 0.85), (365.0, 0.65)] {
        let arc = NSBezierPath()
        arc.appendArc(withCenter: c, radius: r, startAngle: 45, endAngle: 135)
        arc.lineWidth = 62
        arc.lineCapStyle = .round
        NSColor(white: 1, alpha: a).setStroke()
        arc.stroke()
    }

    // location pin: teardrop whose head sits at the arcs' centre
    let headR: CGFloat = 78, tip = CGPoint(x: 512, y: 250)
    let pin = NSBezierPath()
    let ang = asin(headR / (c.y - tip.y))  // tangent angle from tip to head circle
    let tangentDeg = 90 - ang * 180 / .pi
    pin.move(to: tip)
    pin.appendArc(withCenter: c, radius: headR, startAngle: -tangentDeg, endAngle: 180 + tangentDeg, clockwise: false)
    pin.close()
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: NSColor(white: 0, alpha: 0.3).cgColor)
    NSColor.white.setFill(); pin.fill()
    ctx.restoreGState()
    NSColor(srgbRed: 1.0, green: 0.62, blue: 0.20, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: c.x - 34, y: c.y - 34, width: 68, height: 68)).fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
