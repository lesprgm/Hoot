import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private struct Arguments {
    let excludedProcessIDs: Set<pid_t>
}

private enum CaptureHostError: LocalizedError {
    case missingDisplay
    case excludedApplicationsNotFound
    case screenshotUnavailable
    case pngEncodingFailed

    var errorDescription: String? {
        switch self {
        case .missingDisplay:
            return "The primary display was not available to ScreenCaptureKit."
        case .excludedApplicationsNotFound:
            return "ScreenCaptureKit could not resolve any Hoots process IDs for exclusion."
        case .screenshotUnavailable:
            return "ScreenCaptureKit did not return a screenshot."
        case .pngEncodingFailed:
            return "The filtered screenshot could not be encoded as PNG."
        }
    }
}

private func parseArguments() -> Arguments {
    var excluded = Set<pid_t>()
    var index = 1
    let argv = CommandLine.arguments
    while index < argv.count {
        if argv[index] == "--exclude-pids", index + 1 < argv.count {
            for raw in argv[index + 1].split(separator: ",") {
                if let value = pid_t(raw) {
                    excluded.insert(value)
                }
            }
            index += 2
            continue
        }
        index += 1
    }
    return Arguments(excludedProcessIDs: excluded)
}

@available(macOS 14.0, *)
private func capturePNG(arguments: Arguments) async throws -> Data {
    let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let primaryDisplayID = CGMainDisplayID()
    guard let display = shareableContent.displays.first(where: { $0.displayID == primaryDisplayID }) ?? shareableContent.displays.first else {
        throw CaptureHostError.missingDisplay
    }

    let excludedApplications = shareableContent.applications.filter { arguments.excludedProcessIDs.contains($0.processID) }
    if !arguments.excludedProcessIDs.isEmpty && excludedApplications.isEmpty {
        throw CaptureHostError.excludedApplicationsNotFound
    }
    let filter = SCContentFilter(
        display: display,
        excludingApplications: excludedApplications,
        exceptingWindows: []
    )
    // `captureImage` uses the stream configuration type on macOS 14–25.
    // `SCScreenshotConfiguration` is the newer macOS 26 API for
    // `captureScreenshot` and is not accepted by this overload.
    let configuration = SCStreamConfiguration()
    configuration.showsCursor = false
    configuration.width = display.width
    configuration.height = display.height
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)

    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
        throw CaptureHostError.pngEncodingFailed
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw CaptureHostError.pngEncodingFailed
    }
    return output as Data
}

@main
private struct ScreenCaptureHost {
    static func main() async {
        do {
            guard #available(macOS 14.0, *) else {
                throw CaptureHostError.screenshotUnavailable
            }
            let png = try await capturePNG(arguments: parseArguments())
            FileHandle.standardOutput.write(png)
        } catch {
            let message = error.localizedDescription.replacingOccurrences(of: "\n", with: " ")
            FileHandle.standardError.write(Data("View filtered capture failed: \(message)\n".utf8))
            Foundation.exit(EXIT_FAILURE)
        }
    }
}
