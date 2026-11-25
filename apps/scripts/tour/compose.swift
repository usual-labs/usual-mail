// Composes one clip of the onboarding tour (apps/scripts/make-tour.sh) from captures of the Mac app's window or the
// iPhone app's screen: a drawn pointer that moves and clicks (on the iPhone, a touch where the finger lands),
// crossfades from one captured state to the next, and an optional slow zoom. It writes raw BGRA frames to stdout for
// ffmpeg to encode. Nothing here drives the app: each state is its own capture, opened with the app's launch options.
//
// Usage: swift compose.swift <clip.json> <captures folder>  (clip format: see `Clip` below)

import AppKit
import CoreGraphics
import Foundation
import ImageIO

/// One clip: its frame, the window it shows (in points), the captured states it moves between, and its steps.
struct Clip: Decodable {
    /// Frames a second (30), the frame's size in pixels (1280 x 832), and the captured window's size in points
    /// (1512 x 982; its PNGs are twice that). An iPhone clip gives its own (600 x 1304, a 402 x 874 screen at 3x).
    var fps: Int?
    var width: Int?
    var height: Int?
    var window: [Double]?
    /// How a click shows: `arrow`, the Mac's pointer, moving to it (the default); or `touch`, the iPhone's, a disc
    /// where the finger lands, nothing between.
    var pointer: String?
    /// State name to capture file, where it isn't `<state>.png`.
    var states: [String: String]?
    /// How the clip frames the window at rest: a zoom and its center in points (the whole window without).
    var view: [Double]?
    var start: Start
    var steps: [Step]

    struct Start: Decodable {
        var state: String
        var pointer: [Double]
    }

    /// One step: `wait` seconds; `move` the pointer to a point in `duration`; `click` (then show `show`, crossfading);
    /// `zoom` to a scale around `center` in `duration` (1 is the whole window); `back` to how the clip began (its
    /// state, pointer and `view`), so it loops without a jump.
    struct Step: Decodable {
        var wait: Double?
        var move: [Double]?
        var duration: Double?
        var click: Bool?
        var show: String?
        var zoom: Double?
        var center: [Double]?
        var back: Bool?
    }
}

/// A value over time: keyframes eased in and out between, held after the last.
struct Track<Value> {
    var keys: [(time: Double, value: Value)]
    let mix: (Value, Value, Double) -> Value

    func at(_ time: Double) -> Value {
        guard let first = keys.first else { fatalError("an empty track") }
        if time <= first.time { return first.value }
        for (a, b) in zip(keys, keys.dropFirst()) where time < b.time {
            let span = b.time - a.time
            let p = span > 0 ? (time - a.time) / span : 1
            return mix(a.value, b.value, ease(p))
        }
        return keys[keys.count - 1].value
    }

    mutating func add(_ time: Double, _ value: Value) {
        keys.append((time, value))
    }
}

func ease(_ p: Double) -> Double {
    p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
}

func mixPoint(_ a: CGPoint, _ b: CGPoint, _ p: Double) -> CGPoint {
    CGPoint(x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p)
}

struct Camera {
    var zoom: Double
    var center: CGPoint
}

struct Fade {
    let start: Double
    let end: Double
    let from: String
    let to: String
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("Usage: swift compose.swift <clip.json> <captures folder>\n".data(using: .utf8)!)
    exit(64)
}
let clip = try JSONDecoder().decode(Clip.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
let folder = URL(fileURLWithPath: arguments[2])

func image(_ name: String) -> CGImage {
    let url = folder.appendingPathComponent(clip.states?[name] ?? "\(name).png")
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { fatalError("Can't read \(url.path)") }
    return image
}

let fps = clip.fps ?? 30
let windowPoints = clip.window ?? [1512, 982]
let windowSize = CGSize(width: windowPoints[0], height: windowPoints[1])
let windowCenter = CGPoint(x: windowSize.width / 2, y: windowSize.height / 2)
let point = { (values: [Double]) in CGPoint(x: values[0], y: values[1]) }

// The timeline, step by step.
var now = 0.0
var state = clip.start.state
var pointer = Track(keys: [(0, point(clip.start.pointer))], mix: mixPoint)
let rest = clip.view.map { Camera(zoom: $0[0], center: CGPoint(x: $0[1], y: $0[2])) } ?? Camera(zoom: 1, center: windowCenter)
var camera = Track(keys: [(0, rest)]) { a, b, p in
    Camera(zoom: a.zoom + (b.zoom - a.zoom) * p, center: mixPoint(a.center, b.center, p))
}
var fades: [Fade] = []
var clicks: [Double] = []
let clickTime = 0.22
let fadeTime = 0.4
for step in clip.steps {
    if let wait = step.wait { now += wait }
    if let target = step.move {
        let duration = step.duration ?? 0.9
        pointer.add(now, pointer.at(now))
        now += duration
        pointer.add(now, point(target))
    }
    if step.click == true {
        clicks.append(now)
        now += clickTime
    }
    if let next = step.show {
        fades.append(Fade(start: now, end: now + fadeTime, from: state, to: next))
        state = next
        now += fadeTime
    }
    if let zoom = step.zoom {
        let duration = step.duration ?? 1.2
        camera.add(now, camera.at(now))
        now += duration
        camera.add(now, Camera(zoom: zoom, center: step.center.map(point) ?? windowCenter))
    }
    if step.back == true {
        let duration = step.duration ?? 0.7
        pointer.add(now, pointer.at(now))
        camera.add(now, camera.at(now))
        fades.append(Fade(start: now, end: now + duration, from: state, to: clip.start.state))
        state = clip.start.state
        now += duration
        pointer.add(now, point(clip.start.pointer))
        camera.add(now, rest)
    }
}
let duration = now
let frames = Int((duration * Double(fps)).rounded())

// Every capture once.
var images: [String: CGImage] = [:]
for name in Set([clip.start.state] + fades.flatMap { [$0.from, $0.to] }) { images[name] = image(name) }

let touches = clip.pointer == "touch"
let width = clip.width ?? 1280
let height = clip.height ?? 832
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
let base = Double(width) / windowSize.width
/// The card's ground, under the capture's rounded corners.
let ground = CGColor(srgbRed: 0.93, green: 0.94, blue: 0.93, alpha: 1)

/// The pointer, drawn here (no system cursor image): a classic arrow, black with a white edge, its tip at the origin.
let arrow: CGPath = {
    let path = CGMutablePath()
    let points: [(Double, Double)] = [(0, 0), (0, 17), (4.4, 13), (7.2, 19.4), (9.6, 18.4), (6.9, 12.2), (12.4, 12.2)]
    path.move(to: CGPoint(x: points[0].0, y: points[0].1))
    for (x, y) in points.dropFirst() { path.addLine(to: CGPoint(x: x, y: y)) }
    path.closeSubpath()
    return path
}()

func render(_ time: Double) {
    let cam = camera.at(time)
    // Window points to frame pixels, the frame's y pointing down like the window's.
    let scale = base * cam.zoom
    let halfWidth = windowSize.width / 2 / cam.zoom
    let halfHeight = windowSize.height / 2 / cam.zoom
    let center = CGPoint(
        x: min(max(cam.center.x, halfWidth), windowSize.width - halfWidth),
        y: min(max(cam.center.y, halfHeight), windowSize.height - halfHeight))
    func toFrame(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - center.x) * scale + Double(width) / 2, y: (p.y - center.y) * scale + Double(height) / 2)
    }

    context.saveGState()
    context.setFillColor(ground)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // CoreGraphics' y points up: flip once, then draw in the frame's own coordinates.
    context.translateBy(x: 0, y: Double(height))
    context.scaleBy(x: 1, y: -1)

    let origin = toFrame(.zero)
    let windowRect = CGRect(x: origin.x, y: origin.y, width: windowSize.width * scale, height: windowSize.height * scale)
    func draw(_ name: String, alpha: Double) {
        guard let picture = images[name] else { return }
        context.saveGState()
        context.setAlpha(alpha)
        // Images draw upright in a flipped context only when flipped back around their own rect.
        context.translateBy(x: windowRect.minX, y: windowRect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.interpolationQuality = .high
        context.draw(picture, in: CGRect(origin: .zero, size: windowRect.size))
        context.restoreGState()
    }
    let fade = fades.last { time >= $0.start && time < $0.end }
    let shown = fades.last { time >= $0.end }?.to ?? clip.start.state
    if let fade {
        draw(fade.from, alpha: 1)
        draw(fade.to, alpha: ease((time - fade.start) / (fade.end - fade.start)))
    } else {
        draw(shown, alpha: 1)
    }

    if touches {
        drawTouches(time, scale: scale, toFrame: toFrame)
        context.restoreGState()
        return
    }

    // A click: a ring that widens and fades from the pointer's tip, the pointer pressed a little meanwhile.
    let tip = toFrame(pointer.at(time))
    let size = base * (0.75 + 0.25 * cam.zoom) * 1.25
    var pressed = 1.0
    for click in clicks where time >= click && time < click + 0.5 {
        let p = (time - click) / 0.5
        let radius = (8 + 22 * ease(p)) * size
        context.setStrokeColor(CGColor(srgbRed: 0.05, green: 0.06, blue: 0.08, alpha: 0.35 * (1 - p)))
        context.setLineWidth(2 * size)
        context.strokeEllipse(in: CGRect(x: tip.x - radius, y: tip.y - radius, width: radius * 2, height: radius * 2))
        if time < click + 0.16 { pressed = 0.86 }
    }

    context.saveGState()
    context.translateBy(x: tip.x, y: tip.y)
    context.scaleBy(x: size * pressed, y: size * pressed)
    context.setShadow(offset: CGSize(width: 0, height: -1), blur: 3, color: CGColor(gray: 0, alpha: 0.35))
    context.addPath(arrow)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillPath()
    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.addPath(arrow)
    context.setStrokeColor(CGColor(gray: 1, alpha: 1))
    context.setLineWidth(1.3)
    context.setLineJoin(.round)
    context.strokePath()
    context.restoreGState()

    context.restoreGState()
}

/// A touch, as iOS shows one: a grey disc with a light edge at the finger, landing just before the tap, held while
/// pressed, then lifting (it widens a little as it fades). `scale` is pixels a point.
func drawTouches(_ time: Double, scale: Double, toFrame: (CGPoint) -> CGPoint) {
    for click in clicks where time >= click - 0.18 && time < click + 0.5 {
        let t = time - click
        let shown: Double
        let grow: Double
        if t < 0 {
            let p = ease((t + 0.18) / 0.18)
            (shown, grow) = (p, 1.15 - 0.15 * p)
        } else if t < 0.2 {
            (shown, grow) = (1, 1)
        } else {
            let p = ease((t - 0.2) / 0.3)
            (shown, grow) = (1 - p, 1 + 0.25 * p)
        }
        let at = toFrame(pointer.at(click))
        let radius = 19 * grow * scale
        let disc = CGRect(x: at.x - radius, y: at.y - radius, width: radius * 2, height: radius * 2)
        context.setFillColor(CGColor(gray: 0.45, alpha: 0.42 * shown))
        context.fillEllipse(in: disc)
        context.setStrokeColor(CGColor(gray: 1, alpha: 0.85 * shown))
        context.setLineWidth(1.5 * scale)
        context.strokeEllipse(in: disc.insetBy(dx: 0.75 * scale, dy: 0.75 * scale))
    }
}

let out = FileHandle.standardOutput
for frame in 0..<frames {
    render(Double(frame) / Double(fps))
    let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
    out.write(Data(bytes: bytes, count: width * height * 4))
}
FileHandle.standardError.write("\(frames) frames, \(String(format: "%.1f", duration)) s\n".data(using: .utf8)!)
