// SPDX-License-Identifier: Apache-2.0

import AppKit
import Carbon
import Foundation

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var launched = false
    private var workerProcess: Process?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(event:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let raw = CommandLine.arguments.dropFirst().first,
           raw.hasPrefix("appstrate-browser://") {
            launchWorker(raw)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            if self?.launched == false { NSApp.terminate(nil) }
        }
    }

    @objc private func handleURL(event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              raw.hasPrefix("appstrate-browser://") else {
            NSApp.terminate(nil)
            return
        }
        launchWorker(raw)
    }

    private func launchWorker(_ capability: String) {
        if launched { return }
        launched = true
        guard let worker = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("appstrate-browser-worker") else {
            NSApp.terminate(nil)
            return
        }
        let process = Process()
        process.executableURL = worker
        process.arguments = ["--capability-stdin"]
        let input = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardError = errors
        process.terminationHandler = { [weak self] completed in
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                if completed.terminationStatus != 0 {
                    let alert = NSAlert()
                    alert.messageText = "La connexion Appstrate a échoué"
                    alert.informativeText = detail?.isEmpty == false
                        ? detail!
                        : "Le compagnon navigateur s’est arrêté de façon inattendue."
                    alert.runModal()
                }
                self?.workerProcess = nil
                NSApp.terminate(nil)
            }
        }
        do {
            workerProcess = process
            try process.run()
            if let data = capability.data(using: .utf8) {
                input.fileHandleForWriting.write(data)
            }
            try? input.fileHandleForWriting.close()
        } catch {
            workerProcess = nil
            let alert = NSAlert()
            alert.messageText = "Impossible de lancer le compagnon Appstrate"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
}
